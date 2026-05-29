/**
 * Push local category changes back to the Up Bank API.
 *
 * PiggyBack's categorisation chain (user override → merchant rule → Up's own
 * category → global default → inferrer → null) is applied locally. By default
 * those local changes never reach Up, so the Up phone app diverges from what
 * PiggyBack shows. This helper closes that gap by calling
 * PATCH /transactions/{id}/relationships/category against the user's PAT.
 *
 * Gated by env `SYNC_CATEGORIES_TO_UP=true` (default off) so the upstream
 * project can opt in. Default off means production behaviour is unchanged.
 *
 * Safe to call with empty/invalid inputs — it short-circuits without throwing
 * and never propagates errors to the caller. A revoked token flips
 * `up_api_configs.is_active = false` so subsequent calls early-exit.
 *
 * Endpoint is idempotent (returns 204 whether or not the category changed),
 * so retries / replays are harmless.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/utils/supabase/service-role";
import { getPlaintextToken } from "@/lib/token-encryption";
import { createUpApiClient, type UpApiClient } from "@/lib/up-api";
import { UpUnauthorizedError } from "@/lib/up-errors";
import { auditLog, AuditAction } from "@/lib/audit-logger";

/** Category IDs PiggyBack invents that don't exist in Up's taxonomy. */
const PIGGYBACK_ONLY_CATEGORY_IDS = new Set<string>([
  "salary-income",
  "internal-transfer",
  "external-transfer",
  "round-up",
  "interest",
  "investments",
]);

const CONCURRENCY = 5;
/**
 * Defensive scrubber for bearer tokens that may have folded into thrown
 * error messages. The current `up-api.ts` request layer does NOT include the
 * bearer in any error it constructs (UpClientError/UpServerError messages
 * come from the API's own JSON:API error payload), so this regex is
 * belt-and-braces against future refactors. Up Bank PATs contain colons
 * (`up:yeah:...`); `\S+` is intentional to cover that format.
 */
const BEARER_TOKEN_REGEX = /Bearer\s+\S+/g;

export interface PushItem {
  upTransactionId: string | null;
  categoryId: string | null;
}

export interface PushResult {
  tokenRevoked: boolean;
}

/**
 * Push one or more category changes to Up Bank.
 *
 * Single-item callers pass `[{ upTransactionId, categoryId }]`.
 *
 * Per-item skips (do not throw, do not contribute to result):
 *   - feature flag off
 *   - empty userId
 *   - categoryId is null
 *   - categoryId is one of PIGGYBACK_ONLY_CATEGORY_IDS (no Up equivalent)
 *   - upTransactionId is null
 *   - no `up_api_configs` row for this user, or row has `is_active = false`
 *   - categoryId is not present in `category_mappings.up_category_id`
 *
 * Per-item errors are logged (sanitised) and swallowed. A 401 from Up marks
 * the user's token inactive exactly once even under concurrent failures, then
 * subsequent items short-circuit.
 */
export async function pushCategoriesToUp(
  userId: string,
  items: PushItem[],
): Promise<PushResult> {
  // 1. Feature gate
  if (process.env.SYNC_CATEGORIES_TO_UP !== "true") {
    return { tokenRevoked: false };
  }

  // 2. PostgREST `.eq('user_id', null)` matches IS NULL rows. Guard so a
  //    bug-induced empty userId can never read another row.
  if (!userId) {
    return { tokenRevoked: false };
  }

  if (items.length === 0) {
    return { tokenRevoked: false };
  }

  const supabase = createServiceRoleClient();

  // 3. Load the user's Up config once.
  const { data: config } = await supabase
    .from("up_api_configs")
    .select("encrypted_token, is_active")
    .eq("user_id", userId)
    .maybeSingle();

  if (!config || config.is_active === false) {
    return { tokenRevoked: false };
  }

  // 4. Decrypt token, build one client for the batch.
  let token: string;
  try {
    token = getPlaintextToken(config.encrypted_token);
  } catch (err) {
    logSyncError({ stage: "decrypt", userId, err });
    return { tokenRevoked: false };
  }
  const client = createUpApiClient(token);

  // 5. Load the global Up-valid category id set once. category_mappings has
  //    no user_id column — it is a global table populated by an installer.
  const { data: mappings } = await supabase
    .from("category_mappings")
    .select("up_category_id");

  const validUpCategoryIds = new Set<string>(
    (mappings ?? [])
      .map((m) => (m as { up_category_id?: string | null }).up_category_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );

  // 6. Process items with bounded concurrency. State shared across items:
  //    - tokenRevoked deduplicates the is_active=false write so 5 concurrent
  //      401s issue 1 DB write, not 5.
  const state = { tokenRevoked: false };
  await runWithConcurrency(items, CONCURRENCY, async (item) => {
    await processItem({ item, userId, client, validUpCategoryIds, supabase, state });
  });

  return { tokenRevoked: state.tokenRevoked };
}

interface ProcessParams {
  item: PushItem;
  userId: string;
  client: UpApiClient;
  validUpCategoryIds: Set<string>;
  supabase: SupabaseClient;
  state: { tokenRevoked: boolean };
}

async function processItem({
  item,
  userId,
  client,
  validUpCategoryIds,
  supabase,
  state,
}: ProcessParams): Promise<void> {
  // Once a 401 lands, every other in-flight item is wasted work — short-
  // circuit instead of producing another 401.
  if (state.tokenRevoked) {
    return;
  }
  const { upTransactionId, categoryId } = item;
  if (!categoryId || !upTransactionId) return;
  if (PIGGYBACK_ONLY_CATEGORY_IDS.has(categoryId)) return;
  if (!validUpCategoryIds.has(categoryId)) return;

  try {
    await client.categorizeTransaction(upTransactionId, categoryId);
  } catch (err) {
    if (err instanceof UpUnauthorizedError) {
      if (!state.tokenRevoked) {
        state.tokenRevoked = true;
        await markTokenRevoked(supabase, userId);
        // Route through auditLog so the revocation event has the same
        // shape as other critical operations and is ready for an
        // audit_logs table migration.
        auditLog({
          userId,
          action: AuditAction.UP_TOKEN_REVOKED,
          details: { reason: "up_401_during_category_sync" },
        });
      }
      return;
    }
    logSyncError({ stage: "push", userId, upTransactionId, err });
  }
}

async function markTokenRevoked(supabase: SupabaseClient, userId: string): Promise<void> {
  try {
    await supabase
      .from("up_api_configs")
      .update({ is_active: false })
      .eq("user_id", userId);
  } catch (err) {
    logSyncError({ stage: "mark_revoked", userId, err });
  }
}

/**
 * Bounded-parallelism runner. Avoids adding p-limit as a dep — only ~10 LOC.
 * Order of work-items is preserved; results are not collected (each task is
 * expected to handle its own success/failure).
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, items.length);
  for (let i = 0; i < workerCount; i++) {
    runners.push(
      (async () => {
        while (cursor < items.length) {
          const index = cursor++;
          await worker(items[index]);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

interface SyncLog {
  stage: string;
  userId: string;
  upTransactionId?: string;
  err: unknown;
}

function logSyncError(entry: SyncLog): void {
  // Shape mirrors auditLog() so a future audit_logs table migration can
  // ingest both without divergent parsers.
  console.log(
    JSON.stringify({
      level: "error" as const,
      timestamp: new Date().toISOString(),
      source: "sync-category-to-up",
      stage: entry.stage,
      userId: entry.userId,
      upTransactionId: entry.upTransactionId,
      message: sanitiseErr(entry.err),
    }),
  );
}

/**
 * Stringify an unknown error for logging, scrubbing any bearer tokens that may
 * have been folded into the error context. Up tokens contain colons
 * (`up:yeah:...`), so the regex matches `Bearer ` plus any non-whitespace run.
 */
function sanitiseErr(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(BEARER_TOKEN_REGEX, "Bearer [REDACTED]");
}

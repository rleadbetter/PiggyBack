import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the service-role client + token decryption to keep tests hermetic.
vi.mock("@/utils/supabase/service-role", () => ({
  createServiceRoleClient: vi.fn(),
}));
vi.mock("@/lib/token-encryption", () => ({
  getPlaintextToken: vi.fn((s: string) => s.replace(/^encrypted:/, "")),
}));

interface MockTableState {
  // What .maybeSingle() will resolve to.
  maybeSingleResult?: { data: unknown; error: unknown };
  // What .select() (terminal) will resolve to.
  selectResult?: { data: unknown; error: unknown };
  // Tracks calls to .update(...).eq(...).
  updates: Array<{ values: unknown; eq?: [string, unknown] }>;
}

type TableSetup = Record<string, MockTableState>;

function createMockSupabase(setup: TableSetup) {
  const tables: TableSetup = { ...setup };
  return {
    from: vi.fn((tableName: string) => {
      const state = (tables[tableName] = tables[tableName] || { updates: [] });
      const builder: any = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        maybeSingle: vi.fn(() => Promise.resolve(state.maybeSingleResult ?? { data: null, error: null })),
        then: undefined, // not a thenable by default
        // .select() terminal (used by category_mappings query that has no .eq).
        // We expose it via Promise resolution by making .select() chain into an
        // object that resolves when awaited.
      };
      // Make `await supabase.from('category_mappings').select(...)` resolve
      // by giving the chain a custom then():
      builder.select.mockImplementation(() => {
        const chain: any = {
          eq: builder.eq,
          maybeSingle: builder.maybeSingle,
          then: (resolve: (v: { data: unknown; error: unknown }) => void) =>
            resolve(state.selectResult ?? { data: null, error: null }),
        };
        return chain;
      });
      builder.update = vi.fn((values: unknown) => {
        let captured: [string, unknown] | undefined;
        const updateChain: any = {
          eq: vi.fn((col: string, val: unknown) => {
            captured = [col, val];
            state.updates.push({ values, eq: captured });
            return Promise.resolve({ data: null, error: null });
          }),
        };
        return updateChain;
      });
      return builder;
    }),
    _tables: tables,
  };
}

const USER = "user-abc";
const ENC_TOKEN = "encrypted:up:yeah:token-123";
const VALID_CAT = "good-eats-and-treats";
const VALID_MAPPINGS = [{ up_category_id: VALID_CAT }, { up_category_id: "other-real-id" }];

const ACTIVE_CONFIG = {
  maybeSingleResult: { data: { encrypted_token: ENC_TOKEN, is_active: true }, error: null },
  updates: [] as MockTableState["updates"],
};

const VALID_MAPPING_RESULT = {
  selectResult: { data: VALID_MAPPINGS, error: null },
  updates: [] as MockTableState["updates"],
};

describe("pushCategoriesToUp", () => {
  let originalFlag: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    originalFlag = process.env.SYNC_CATEGORIES_TO_UP;
    process.env.SYNC_CATEGORIES_TO_UP = "true";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalFlag === undefined) {
      delete process.env.SYNC_CATEGORIES_TO_UP;
    } else {
      process.env.SYNC_CATEGORIES_TO_UP = originalFlag;
    }
  });

  it("T1: SYNC_CATEGORIES_TO_UP unset → no fetch, tokenRevoked false", async () => {
    delete process.env.SYNC_CATEGORIES_TO_UP;
    const { pushCategoriesToUp } = await import("@/lib/sync-category-to-up");
    const result = await pushCategoriesToUp(USER, [{ upTransactionId: "txn-1", categoryId: VALID_CAT }]);
    expect(result).toEqual({ tokenRevoked: false });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("T2: empty userId → no fetch", async () => {
    const { pushCategoriesToUp } = await import("@/lib/sync-category-to-up");
    const result = await pushCategoriesToUp("", [{ upTransactionId: "txn-1", categoryId: VALID_CAT }]);
    expect(result).toEqual({ tokenRevoked: false });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("T3: categoryId null → skipped, no fetch", async () => {
    const { createServiceRoleClient } = await import("@/utils/supabase/service-role");
    (createServiceRoleClient as any).mockReturnValue(
      createMockSupabase({ up_api_configs: ACTIVE_CONFIG, category_mappings: VALID_MAPPING_RESULT }),
    );
    const { pushCategoriesToUp } = await import("@/lib/sync-category-to-up");
    await pushCategoriesToUp(USER, [{ upTransactionId: "txn-1", categoryId: null }]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("T4: PiggyBack-only inferred ids skipped per-item, no fetch", async () => {
    const { createServiceRoleClient } = await import("@/utils/supabase/service-role");
    (createServiceRoleClient as any).mockReturnValue(
      createMockSupabase({ up_api_configs: ACTIVE_CONFIG, category_mappings: VALID_MAPPING_RESULT }),
    );
    const { pushCategoriesToUp } = await import("@/lib/sync-category-to-up");
    const inferred = [
      "salary-income",
      "internal-transfer",
      "external-transfer",
      "round-up",
      "interest",
      "investments",
    ];
    await pushCategoriesToUp(
      USER,
      inferred.map((cat, i) => ({ upTransactionId: `txn-${i}`, categoryId: cat })),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("T5: upTransactionId null → skipped, no fetch", async () => {
    const { createServiceRoleClient } = await import("@/utils/supabase/service-role");
    (createServiceRoleClient as any).mockReturnValue(
      createMockSupabase({ up_api_configs: ACTIVE_CONFIG, category_mappings: VALID_MAPPING_RESULT }),
    );
    const { pushCategoriesToUp } = await import("@/lib/sync-category-to-up");
    await pushCategoriesToUp(USER, [{ upTransactionId: null, categoryId: VALID_CAT }]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("T6a: up_api_configs row missing → no fetch", async () => {
    const { createServiceRoleClient } = await import("@/utils/supabase/service-role");
    (createServiceRoleClient as any).mockReturnValue(
      createMockSupabase({
        up_api_configs: { maybeSingleResult: { data: null, error: null }, updates: [] },
        category_mappings: VALID_MAPPING_RESULT,
      }),
    );
    const { pushCategoriesToUp } = await import("@/lib/sync-category-to-up");
    await pushCategoriesToUp(USER, [{ upTransactionId: "txn-1", categoryId: VALID_CAT }]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("T6b: is_active=false → no fetch", async () => {
    const { createServiceRoleClient } = await import("@/utils/supabase/service-role");
    (createServiceRoleClient as any).mockReturnValue(
      createMockSupabase({
        up_api_configs: {
          maybeSingleResult: { data: { encrypted_token: ENC_TOKEN, is_active: false }, error: null },
          updates: [],
        },
        category_mappings: VALID_MAPPING_RESULT,
      }),
    );
    const { pushCategoriesToUp } = await import("@/lib/sync-category-to-up");
    await pushCategoriesToUp(USER, [{ upTransactionId: "txn-1", categoryId: VALID_CAT }]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("T7: happy path single item → PATCH with correct body & auth", async () => {
    (global.fetch as any).mockResolvedValue({ ok: true, status: 204, json: () => Promise.resolve({}) });
    const { createServiceRoleClient } = await import("@/utils/supabase/service-role");
    (createServiceRoleClient as any).mockReturnValue(
      createMockSupabase({ up_api_configs: ACTIVE_CONFIG, category_mappings: VALID_MAPPING_RESULT }),
    );
    const { pushCategoriesToUp } = await import("@/lib/sync-category-to-up");
    const result = await pushCategoriesToUp(USER, [
      { upTransactionId: "txn-abc", categoryId: VALID_CAT },
    ]);
    expect(result).toEqual({ tokenRevoked: false });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toContain("/transactions/txn-abc/relationships/category");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ data: { type: "categories", id: VALID_CAT } });
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer up:yeah:/);
  });

  it("T8: 401 → mark token revoked once, audit-log event emitted, no throw", async () => {
    // Return 401 for every call; the short-circuit means only the first item
    // will trigger the UPDATE/auditLog pair.
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ errors: [{ detail: "unauthorized" }] }),
      headers: new Map(),
    });
    const supabase = createMockSupabase({
      up_api_configs: { ...ACTIVE_CONFIG, updates: [] },
      category_mappings: VALID_MAPPING_RESULT,
    });
    const { createServiceRoleClient } = await import("@/utils/supabase/service-role");
    (createServiceRoleClient as any).mockReturnValue(supabase);
    // Capture audit-log JSON lines from console.log.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { pushCategoriesToUp } = await import("@/lib/sync-category-to-up");
    const result = await pushCategoriesToUp(USER, [
      { upTransactionId: "txn-1", categoryId: VALID_CAT },
      { upTransactionId: "txn-2", categoryId: VALID_CAT },
      { upTransactionId: "txn-3", categoryId: VALID_CAT },
    ]);
    expect(result).toEqual({ tokenRevoked: true });
    // Exactly one is_active=false UPDATE.
    const updates = (supabase as any)._tables.up_api_configs.updates;
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toEqual({ is_active: false });
    expect(updates[0].eq).toEqual(["user_id", USER]);
    // Exactly one auditLog UP_TOKEN_REVOKED line — shape mirrors auditLog().
    const auditLines = logSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => !!e && e.action === "UP_TOKEN_REVOKED");
    expect(auditLines).toHaveLength(1);
    expect(auditLines[0]).toMatchObject({
      level: "audit",
      userId: USER,
      action: "UP_TOKEN_REVOKED",
      details: { reason: "up_401_during_category_sync" },
    });
    expect(typeof auditLines[0].timestamp).toBe("string");
    logSpy.mockRestore();
  });

  it("T9: bounded concurrency of 5 across 20 items, all complete", async () => {
    let inFlight = 0;
    let peak = 0;
    let completed = 0;
    (global.fetch as any).mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield once so the scheduler can dispatch more workers.
      await new Promise((r) => setTimeout(r, 0));
      inFlight--;
      completed++;
      return { ok: true, status: 204, json: () => Promise.resolve({}) };
    });
    const { createServiceRoleClient } = await import("@/utils/supabase/service-role");
    (createServiceRoleClient as any).mockReturnValue(
      createMockSupabase({ up_api_configs: ACTIVE_CONFIG, category_mappings: VALID_MAPPING_RESULT }),
    );
    const { pushCategoriesToUp } = await import("@/lib/sync-category-to-up");
    const items = Array.from({ length: 20 }, (_, i) => ({
      upTransactionId: `txn-${i}`,
      categoryId: VALID_CAT,
    }));
    await pushCategoriesToUp(USER, items);
    expect(completed).toBe(20);
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThanOrEqual(2);
  });
});

-- Unset `category_id = 'round-up'` on parent purchases that the prior
-- inferred categoriser wrongly hijacked.
--
-- Bug shape: a purchase that generated an Up Bank round-up child has
-- `round_up_amount_cents` populated as METADATA describing the child.
-- The prior categoriser interpreted that as "this transaction is a
-- round-up" and assigned category_id = 'round-up', hiding real spending
-- (rego, Amazon, Kmart, eBay, etc.) from analytics under "Round Up Savings".
--
-- The actual round-up children have transaction_type = 'Round Up' and
-- already get classified correctly via the existing transferAccount path.
--
-- This migration is conservative: it only touches rows where the prior
-- buggy inference fired AND no other source of truth has weighed in.
--
-- Safe to run multiple times.

UPDATE public.transactions t
   SET category_id = NULL,
       parent_category_id = NULL
 WHERE t.category_id = 'round-up'
   AND (t.transaction_type IS DISTINCT FROM 'Round Up')
   AND NOT EXISTS (
         SELECT 1 FROM public.transaction_category_overrides o
          WHERE o.transaction_id = t.id
       );

/**
 * A flow's signals are the contract's (D12 Ruling 37).
 *
 *   * flows.signals was any text[] (migration 1700000000026), while the
 *     API's response schemas (FlowSchema, FlowCardSchema in
 *     @telflo/contracts) accept only traces, metrics and logs: a stray value
 *     written by SQL would turn every read of the flow, the signed-out
 *     showcase's included, into a 500. ck_flows_signals keeps the column to
 *     what the API writes, FlowSignalsSchema's rule: each of the three
 *     signals (FLOW_SIGNALS) at most once, in any order, none at all
 *     allowed. A null element, a value in another case, an empty string or
 *     a second dimension is refused too (23514).
 *   * Subqueries aren't allowed in a check, so each signal's count is
 *     array_positions' (every position it holds). array_positions refuses a
 *     multidimensional array with an error rather than false, so the CASE
 *     refuses one first; the case of '{}', whose array_ndims is null, falls
 *     through to the containment, which holds.
 *   * Added with validation: the 13 seeded flows (migration 026's) and every
 *     flow written since hold only the three signals, each once, so up
 *     refuses a database holding a flow that doesn't, changing nothing.
 *     Nothing else changes: no column, grant, policy or row.
 *
 * down drops the check. Migration 026 is left as it was committed.
 */

export const up = (pgm) => {
  pgm.sql(`
    alter table flows add constraint ck_flows_signals check (
      case
        when array_ndims(signals) > 1 then false
        else signals <@ array['traces', 'metrics', 'logs']
             and cardinality(array_positions(signals, 'traces')) <= 1
             and cardinality(array_positions(signals, 'metrics')) <= 1
             and cardinality(array_positions(signals, 'logs')) <= 1
      end
    );

    comment on constraint ck_flows_signals on flows is
      'the contract''s signals (D12 Ruling 37, FlowSignalsSchema): traces,
       metrics and logs, each at most once, in any order, or none; a null
       element or a second dimension is refused too. The API''s response
       schemas accept nothing else, so a stray value would make every read
       of the flow a 500.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    alter table flows drop constraint ck_flows_signals;
  `);
};

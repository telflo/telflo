/**
 * One live reset link per user (D3 Ruling 16).
 *
 * Issuing a reset token consumes the user's earlier unconsumed ones in the
 * same transaction, and that transaction locks the user's row first, so two
 * requests for one user run one after the other. This index makes the rule
 * hold whatever code path writes the table: a second unconsumed token for a
 * user is refused.
 *
 * Before D3's fix wave, two concurrent requests could both commit, leaving two
 * unconsumed tokens. Those are settled first, as the application would have:
 * only the newest link works, so the older ones are consumed.
 */
export const up = (pgm) => {
  pgm.sql(`
    update password_reset_tokens t
       set consumed_at = now()
     where t.consumed_at is null
       and exists (
         select 1 from password_reset_tokens newer
          where newer.user_id = t.user_id
            and newer.consumed_at is null
            and (newer.created_at, newer.id) > (t.created_at, t.id)
       );

    create unique index uq_password_reset_tokens_one_live_per_user
      on password_reset_tokens (user_id)
      where consumed_at is null;

    comment on index uq_password_reset_tokens_one_live_per_user is
      'at most one unconsumed reset token per user: only the newest link works
       (D3 decision 4, Ruling 16). Issuing a token consumes the earlier ones
       under a lock on the user''s row.';
  `);
};

// Deliberately does not un-consume the duplicates `up` retired: which were live is not recorded, and reviving them would break the rule again.
export const down = (pgm) => {
  pgm.sql(`
    drop index if exists uq_password_reset_tokens_one_live_per_user;
  `);
};

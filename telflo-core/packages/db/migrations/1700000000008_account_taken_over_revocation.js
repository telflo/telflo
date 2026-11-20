/**
 * A reason of its own for sessions revoked when a federated sign-in takes over
 * an unverified account. Before, the takeover revoked with password_reset,
 * which reads as if the owner had reset their password. Only the column
 * comment changes: the column is text.
 */
export const up = (pgm) => {
  pgm.sql(`
    comment on column sessions.revoked_reason is
      'one of logout, sign_out_everywhere, refresh_token_reused,
       password_reset or account_taken_over (a federated sign-in took over an
       unverified account). Text rather than an enum until a third consumer
       needs to branch on it.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    comment on column sessions.revoked_reason is
      'one of logout, sign_out_everywhere, refresh_token_reused or
       password_reset. Text rather than an enum until a third consumer needs
       to branch on it.';
  `);
};

/**
 * Password reset tokens.
 *
 * Shaped like email_verification_tokens, but a table of their own rather
 * than a purpose column on that one, so a verification token can never be
 * accepted as a reset token by a missed predicate. A completed reset
 * revokes every session of the user, with the new reason password_reset.
 */
export const up = (pgm) => {
  pgm.sql(`
    create table password_reset_tokens (
      id           uuid        primary key default uuidv7(),
      user_id      uuid        not null references users(id) on delete cascade,
      token_hash   text        not null,
      expires_at   timestamptz not null,
      consumed_at  timestamptz,
      created_at   timestamptz not null default now()
    );

    comment on table password_reset_tokens is
      'single-use links that set a new password. Separate from
       email_verification_tokens so a verification token can never pass as a
       reset token. Issuing one consumes the user''s earlier unconsumed ones,
       so only the newest link works.';
    comment on column password_reset_tokens.token_hash is
      'sha-256 of the token, the same as verification tokens. The plaintext is
       emailed and never stored, so a database leak yields no usable reset
       links.';
    comment on column password_reset_tokens.consumed_at is
      'null until the token is used, or superseded by a newer one or by a
       completed reset. A consumed token is never valid again.';

    create unique index uq_password_reset_tokens_token_hash
      on password_reset_tokens (token_hash);
    create index idx_password_reset_tokens_user_id
      on password_reset_tokens (user_id);

    comment on column sessions.revoked_reason is
      'one of logout, sign_out_everywhere, refresh_token_reused or
       password_reset. Text rather than an enum until a third consumer needs
       to branch on it.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    comment on column sessions.revoked_reason is
      'one of logout, sign_out_everywhere or refresh_token_reused. Text rather
       than an enum until a third consumer needs to branch on it.';

    drop table if exists password_reset_tokens;
  `);
};

/**
 * Sessions and their rotating refresh tokens (D2a).
 *
 * Every authenticated request looks up its session row, so revoking a session
 * takes effect on the next request (ADR 0010, D2a decision 4). A session
 * slides: each refresh issues a new refresh token that lasts the configured
 * number of days from that rotation, with no absolute cap (D2a decision 3).
 */
export const up = (pgm) => {
  pgm.sql(`
    create table sessions (
      id                      uuid        primary key default uuidv7(),
      user_id                 uuid        not null references users(id) on delete cascade,
      active_organization_id  uuid        not null references organizations(id) on delete cascade,
      created_at              timestamptz not null default now(),
      last_refreshed_at       timestamptz not null default now(),
      revoked_at              timestamptz,
      revoked_reason          text,
      ip_address              inet,
      user_agent              text,
      constraint ck_sessions_revoked_reason
        check ((revoked_at is null) = (revoked_reason is null))
    );

    comment on table sessions is
      'one signed-in browser. The access token names its session (sid), and a
       request is accepted only while this row exists and is not revoked, so
       revocation is immediate (ADR 0010). Logout revokes only the current
       session; signing out everywhere revokes all of a user''s sessions
       (D2a decision 8).';
    comment on column sessions.active_organization_id is
      'the organization this session acts as. Sign-in sets it to the user''s
       personal organization, and D5''s switching changes it. It is
       authoritative; the access token carries a copy (ADR 0010).';
    comment on column sessions.last_refreshed_at is
      'when the refresh token was last rotated. The refresh token''s expiry
       slides from each rotation (D2a decision 3).';
    comment on column sessions.revoked_at is
      'null while the session is live. Set together with revoked_reason, never
       one without the other (ck_sessions_revoked_reason).';
    comment on column sessions.revoked_reason is
      'one of logout, sign_out_everywhere or refresh_token_reused. Text rather
       than an enum until a third consumer needs to branch on it.';
    comment on column sessions.ip_address is
      'the client address at sign-in, validated as an IP before it is written
       (D2a decision 10).';

    create index idx_sessions_user_id on sessions (user_id);

    create table refresh_tokens (
      id           uuid        primary key default uuidv7(),
      session_id   uuid        not null references sessions(id) on delete cascade,
      token_hash   text        not null,
      expires_at   timestamptz not null,
      consumed_at  timestamptz,
      created_at   timestamptz not null default now()
    );

    comment on table refresh_tokens is
      'the opaque tokens a session rotates through. Each refresh consumes the
       presented token and issues a new one; presenting a consumed token again
       revokes the session with reason refresh_token_reused.';
    comment on column refresh_tokens.token_hash is
      'sha-256 of the token, the same as verification tokens. The plaintext
       lives only in the telflo_refresh cookie, so a database leak yields no
       usable refresh tokens.';
    comment on column refresh_tokens.consumed_at is
      'null until the token is rotated away. A consumed token is never valid
       again.';

    create unique index uq_refresh_tokens_token_hash on refresh_tokens (token_hash);
    create index idx_refresh_tokens_session_id on refresh_tokens (session_id);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop table if exists refresh_tokens;
    drop table if exists sessions;
  `);
};

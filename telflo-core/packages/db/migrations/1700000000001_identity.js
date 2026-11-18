/**
 * Identity: users, email verification tokens, and the append-only audit log.
 *
 * The audit log starts in D1 rather than being retrofitted (spec §3.7).
 */
export const up = (pgm) => {
  pgm.sql(`
    create table users (
      id                      uuid primary key default uuidv7(),
      email                   text        not null,
      password_hash           text,
      email_verified_at       timestamptz,
      accepted_terms_version  text        not null,
      created_at              timestamptz not null default now(),
      updated_at              timestamptz not null default now(),
      deleted_at              timestamptz
    );

    comment on column users.password_hash is
      'null for users who authenticate only through a federated provider (D2).';
    comment on column users.email_verified_at is
      'null until the verification link is consumed. An unverified account cannot sign in.';

    -- Uniqueness on the lowercased email rather than citext: the extension list
    -- in spec §3.3 is deliberately short, and the application lowercases at the
    -- boundary, so this index is a backstop rather than the only defense.
    create unique index uq_users_lower_email on users (lower(email));

    create table email_verification_tokens (
      id          uuid primary key default uuidv7(),
      user_id     uuid        not null references users(id) on delete cascade,
      token_hash  text        not null,
      expires_at  timestamptz not null,
      consumed_at timestamptz,
      created_at  timestamptz not null default now()
    );

    comment on column email_verification_tokens.token_hash is
      'sha-256 of the token. The plaintext is emailed and never stored, so a
       database leak yields no usable verification links.';

    create unique index uq_email_verification_tokens_token_hash
      on email_verification_tokens (token_hash);
    create index idx_email_verification_tokens_user_id
      on email_verification_tokens (user_id);

    -- "audit_events", not "audit_log": tables are plural snake_case
    -- throughout this schema, and the rows are events -- Task 7's repository
    -- speaks of AuditEvent / record(event). "the audit log" stays accurate
    -- as the conceptual name for what these events compose.
    create table audit_events (
      id              uuid primary key default uuidv7(),
      occurred_at     timestamptz not null default now(),
      actor_user_id   uuid,
      actor_email     text,
      organization_id uuid,
      action          text        not null,
      subject_type    text,
      subject_id      uuid,
      metadata        jsonb       not null default '{}'::jsonb,
      ip_address      inet,
      user_agent      text
    );

    comment on table audit_events is
      'append-only. update and delete are blocked by a trigger below; rows are never modified.';
    comment on column audit_events.actor_user_id is
      'nullable with no foreign key, deliberately: an audit row must not depend
       on its referent still existing, and a foreign key with any on-delete
       action would mutate or destroy this row when the user is deleted. The
       dangling uuid is kept (rather than nulled) so events by the same actor
       stay correlatable; actor_email carries the human-readable identity
       forward independently.';
    comment on column audit_events.actor_email is
      'snapshot taken at write time so the trail survives deletion of the user.';
    comment on column audit_events.organization_id is
      'nullable with no foreign key: organizations arrive in D5, and rows written
       before then must not require a backfill.';

    create index idx_audit_events_occurred_at on audit_events (occurred_at desc);
    create index idx_audit_events_actor_user_id on audit_events (actor_user_id);
    create index idx_audit_events_action on audit_events (action);

    -- Append-only, enforced with a trigger rather than a GRANT/REVOKE. The
    -- compose database role (telflo) is a superuser, and superusers bypass
    -- privilege checks entirely -- a "revoke update, delete on audit_events
    -- from current_user" was verified live to leave UPDATE and DELETE both
    -- fully functional. A BEFORE UPDATE/DELETE trigger does fire for
    -- superusers and was verified to block both, unconditionally: no row
    -- may ever be updated or deleted, no exceptions. (actor_user_id carries
    -- no foreign key, above, precisely so this trigger needs none -- a
    -- smaller security surface than a trigger that has to recognize and
    -- admit one specific kind of write.) Known residual, deliberately
    -- accepted: row-level triggers do not fire on TRUNCATE, so TRUNCATE
    -- still empties this table -- acceptable because TRUNCATE is an
    -- operator-level action, not an application code path, and the tests'
    -- beforeEach relies on it.
    --
    -- The exception raises with the default P0001 (raise_exception)
    -- SQLSTATE rather than a chosen errcode: this is an application
    -- invariant, not a foreign-key rule, and nothing branches on the
    -- SQLSTATE -- the message text carries the meaning.
    create function audit_events_append_only() returns trigger
    language plpgsql as $$
    begin
      raise exception 'audit_events is append-only: % is not permitted', tg_op;
    end;
    $$;

    create trigger audit_events_no_mutate
      before update or delete on audit_events
      for each row execute function audit_events_append_only();
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop table if exists audit_events;
    drop function if exists audit_events_append_only();
    drop table if exists email_verification_tokens;
    drop table if exists users;
  `);
};

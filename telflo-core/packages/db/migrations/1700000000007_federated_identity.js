/**
 * Federated identity and terms acceptance.
 *
 * user_identities links a user to a provider's subject: a user may have
 * several providers' identities, at most one per provider, and a subject
 * belongs to at most one user.
 *
 * users.accepted_terms_version becomes nullable: an account created through
 * a provider has accepted no terms until the terms dialog records it.
 * terms_accepted_at records when; rows that already carry a version are
 * backfilled from created_at, the moment registration recorded it. A check
 * keeps the two columns null together or set together.
 */
export const up = (pgm) => {
  pgm.sql(`
    create table user_identities (
      id                uuid        primary key default uuidv7(),
      user_id           uuid        not null references users(id) on delete cascade,
      provider          text        not null,
      provider_subject  text        not null,
      email             text        not null,
      linked_at         timestamptz not null default now()
    );

    comment on table user_identities is
      'a user''s identity at a federated provider. Sign-in
       finds the user by (provider, provider_subject), never by email.';
    comment on column user_identities.provider is
      'the configured provider''s id, such as google.';
    comment on column user_identities.provider_subject is
      'the provider''s sub claim: stable for the provider''s account, unlike
       its email.';
    comment on column user_identities.email is
      'the provider''s email at link time. A snapshot for the audit trail;
       sign-in never reads it.';

    create unique index uq_user_identities_provider_subject
      on user_identities (provider, provider_subject);
    comment on index uq_user_identities_provider_subject is
      'a provider''s subject is linked to at most one user.';

    create unique index uq_user_identities_user_id_provider
      on user_identities (user_id, provider);
    comment on index uq_user_identities_user_id_provider is
      'at most one identity per provider per user. Also serves lookups
       by user_id.';

    alter table users alter column accepted_terms_version drop not null;
    alter table users add column terms_accepted_at timestamptz;

    update users
       set terms_accepted_at = created_at
     where accepted_terms_version is not null;

    alter table users add constraint chk_users_terms_accepted_together check (
      (accepted_terms_version is null) = (terms_accepted_at is null)
    );

    comment on column users.accepted_terms_version is
      'the terms version the user last accepted, or null for one who has
       accepted none (an account created through a provider, until the terms
       dialog). The current version is CURRENT_TERMS_VERSION in
       @telflo/contracts; any other value means the terms must be accepted
       again.';
    comment on column users.terms_accepted_at is
      'when accepted_terms_version was accepted; null exactly when it is.
       Rows from before this migration were backfilled from created_at.';
  `);
};

// Refuses rather than inventing a terms version for users who never accepted one.
export const down = (pgm) => {
  pgm.sql(`
    do $$
    declare
      users_without_terms bigint;
    begin
      select count(*) into users_without_terms
        from users
       where accepted_terms_version is null;
      if users_without_terms > 0 then
        raise exception
          'cannot restore users.accepted_terms_version to not null: % user(s) have accepted no terms version',
          users_without_terms
          using errcode = 'check_violation';
      end if;
    end
    $$;

    alter table users drop constraint if exists chk_users_terms_accepted_together;
    alter table users drop column if exists terms_accepted_at;
    alter table users alter column accepted_terms_version set not null;

    comment on column users.accepted_terms_version is null;

    drop table if exists user_identities;
  `);
};

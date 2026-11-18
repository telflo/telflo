/**
 * Library files (D23-2 decisions 19, 21 and 28; Preflight ruling 13): the
 * global library of helper files the Learning Telflo tutorials use, with
 * its limits enforced (Q154 fix 1).
 *
 *   * library_files: one row per file. Global (ADR 0008): no organization
 *     column, no row-level security. Every member reads the files through
 *     the API; only a product admin (users.is_product_admin) adds, edits or
 *     deletes one, which the API decides. Deletes are hard: the API removes
 *     the row, then the bytes after the commit (Q154 fix 2). The bytes are
 *     the file store's, `global/library-files/<id>` (ADR 0012), never a
 *     column.
 *   * The checks, each named: the name trimmed, 1 to 200 characters; the
 *     description at most 2,000; the file's own name 1 to 255; the size 0
 *     to 10,485,760 bytes; the SHA-256 32 bytes.
 *   * library_files_guard (refuse_library_file_change): a file is never
 *     replaced (D23-2 "Not in D23-2": delete and add again). Its id, file
 *     name, size, SHA-256 and created_at are fixed, and its creator changes
 *     only to null (the users foreign key's on delete set null), as
 *     refuse_test_template_change (migration 029). Its name and description
 *     may change (the admin's edit).
 *   * Two indexes: the list's (created_at desc, id desc) and the creator's
 *     (migration 029's reason: a hard-deleted account's set null would
 *     otherwise scan the table).
 *
 * Migration 009's default privileges give telflo_platform_runtime select,
 * insert, update and delete on the new table: no grant is needed (a hard
 * delete keeps DELETE).
 *
 * down drops the table, its trigger and its function.
 */

export const up = (pgm) => {
  pgm.sql(`
    create table library_files (
      id                  uuid         primary key default uuidv7(),
      name                text         not null,
      description         text         not null default '',
      file_name           text         not null,
      size_bytes          integer      not null,
      sha256              bytea        not null,
      created_by_user_id  uuid         null references users(id) on delete set null,
      created_at          timestamptz  not null default now(),
      updated_at          timestamptz  not null default now(),
      constraint ck_library_files_name
        check (name = btrim(name) and char_length(name) between 1 and 200),
      constraint ck_library_files_description check (char_length(description) <= 2000),
      constraint ck_library_files_file_name check (char_length(file_name) between 1 and 255),
      constraint ck_library_files_size_bytes check (size_bytes between 0 and 10485760),
      constraint ck_library_files_sha256 check (octet_length(sha256) = 32)
    );

    comment on table library_files is
      'the global library of helper files (D23-2 decisions 5 and 19).
       Global (ADR 0008): no organization
       column, no row-level security. Every member reads them through the
       API; only a product admin (users.is_product_admin) writes them, which
       the API decides. Deletes are hard. The bytes are in the file store at
       global/library-files/<id>.';
    comment on column library_files.id is
      'the file''s id, which names its bytes in the file store and signs its
       library links.';
    comment on column library_files.name is
      'trimmed, 1 to 200 characters. Telflo''s own content: never in an
       attribute, a log line or an audit row.';
    comment on column library_files.description is
      'at most 2,000 characters; the empty string when there is none.';
    comment on column library_files.file_name is
      'the uploaded file''s own name, 1 to 255 characters, which the API
       checks further (no control character, slash or backslash, not . or
       .., no leading -). Never changed.';
    comment on column library_files.size_bytes is
      'the bytes'' size, at most 10,485,760. Never changed.';
    comment on column library_files.sha256 is
      'the bytes'' SHA-256, 32 bytes, as the file store computed it while
       writing them. Never changed.';
    comment on column library_files.created_by_user_id is
      'the product admin who added it. Null once their account is
       hard-deleted; never changed otherwise.';
    comment on column library_files.created_at is
      'written by the API from its clock. The list shows the newest first.
       Never changed.';
    comment on column library_files.updated_at is
      'written by the API from its clock on create and on every change.';

    comment on constraint library_files_pkey on library_files is
      'one row per file, by its id.';
    comment on constraint library_files_created_by_user_id_fkey on library_files is
      'the file''s uploader (23503 otherwise); on delete set null, which the
       guard trigger allows.';
    comment on constraint ck_library_files_name on library_files is
      'the name is trimmed, which the API''s contract does first, and 1 to
       200 characters.';
    comment on constraint ck_library_files_description on library_files is
      'the description is at most 2,000 characters.';
    comment on constraint ck_library_files_file_name on library_files is
      'the file''s name is 1 to 255 characters.';
    comment on constraint ck_library_files_size_bytes on library_files is
      'a library file is at most 10 MiB (D23-2 decision 5).';
    comment on constraint ck_library_files_sha256 on library_files is
      'a SHA-256 is 32 bytes.';

    create index idx_library_files_created_at
      on library_files (created_at desc, id desc);
    create index idx_library_files_created_by_user_id
      on library_files (created_by_user_id);

    comment on index idx_library_files_created_at is
      'the files, newest first: the list.';
    comment on index idx_library_files_created_by_user_id is
      'a hard-deleted account''s set null; without an index that would scan
       the table.';

    -- Not SECURITY DEFINER: it reads only the row it is given. P0001, with a
    -- message naming only the file's id.
    create function refuse_library_file_change() returns trigger
    language plpgsql
    set search_path = pg_catalog, platform
    as $$
    begin
      if (new.id, new.file_name, new.size_bytes, new.sha256, new.created_at)
           is distinct from
         (old.id, old.file_name, old.size_bytes, old.sha256, old.created_at)
         or (new.created_by_user_id is distinct from old.created_by_user_id
             and new.created_by_user_id is not null)
      then
        raise exception 'library file % keeps its file and its creator', old.id;
      end if;
      return new;
    end;
    $$;

    create trigger library_files_guard
      before update on library_files
      for each row execute function refuse_library_file_change();

    comment on function refuse_library_file_change() is
      'a library file''s bytes never change (D23-2 decision 28): its id, file
       name, size, SHA-256 and created_at are fixed, and its creator changes
       only to null (the users foreign key''s on delete set null). Its name
       and description may change (the admin''s edit). P0001, naming only the
       file''s id. Not SECURITY DEFINER: it reads only the row it is given.';
    comment on trigger library_files_guard on library_files is
      'before update, for every role on a plain UPDATE, the API''s and the
       tables'' owner alike. Only an operator can bypass it (ALTER TABLE …
       DISABLE TRIGGER, session_replication_role = replica).';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop table library_files;
    drop function refuse_library_file_change();
  `);
};

-- The platform's database and its owner. Run once, by the Postgres
-- superuser, when the platform's Postgres first creates its data
-- (telflo-initdb.sh, from the postgres image's
-- /docker-entrypoint-initdb.d), beside the opamp-server's own bootstrap;
-- the two don't depend on each other's order.
--
-- The owner's password comes from the environment, TELFLO_OWNER_PASSWORD,
-- read with psql's \getenv, never from a command line (visible in the
-- process list) or a -v argument (\unset first drops any).
--
-- The role telflo_platform_owner owns the database telflo_platform and runs the migrations, which
-- create the API's own role, telflo_platform (application-role.ts). It may log in
-- and create roles, and nothing more: no superuser, no CREATEDB, no
-- BYPASSRLS, no REPLICATION. The superuser runs only this and the
-- opamp-server's bootstrap.
--
-- The password reaches Postgres in `create role` and `alter role`
-- statements, which take no bind parameters: the server must not log
-- statements (no log_statement), and telflo-initdb.sh runs this with
-- log_min_error_statement=panic, so a failing statement isn't logged
-- whole. psql doesn't echo them without -a or -e.
--
-- Idempotent: a rerun creates nothing that exists and sets the password and
-- the attributes again.

\set ON_ERROR_STOP on

\unset owner_password
\getenv owner_password TELFLO_OWNER_PASSWORD
\if :{?owner_password}
\else
  do $$ begin raise exception 'telflo-bootstrap.sql needs TELFLO_OWNER_PASSWORD in its environment'; end $$;
\endif
select :'owner_password' = '' as owner_password_empty
\gset
\if :owner_password_empty
  do $$ begin raise exception 'telflo-bootstrap.sql needs TELFLO_OWNER_PASSWORD to be non-empty'; end $$;
\endif

-- The owner, created only when missing, with `\gexec` because psql doesn't
-- substitute variables inside a DO block.
select format(
         'create role telflo_platform_owner login createrole nosuperuser nocreatedb nobypassrls noreplication password %L',
         :'owner_password')
 where not exists (select 1 from pg_roles where rolname = 'telflo_platform_owner')
\gexec

-- Every run states the attributes and sets the password again.
alter role telflo_platform_owner login createrole nosuperuser nocreatedb nobypassrls noreplication
  password :'owner_password';

-- The database, owned by telflo_platform_owner, UTF8 whatever the server's default, so
-- copied from template0 (the one template a new encoding may come from).
select 'create database telflo_platform owner telflo_platform_owner encoding ''UTF8'' template template0'
 where not exists (select 1 from pg_database where datname = 'telflo_platform')
\gexec

-- An existing database is handed to the owner too (a no-op when it owns it).
alter database telflo_platform owner to telflo_platform_owner;

/**
 * A version's graph: three columns, nodes, edges and
 * pipelines, beside the YAML, so the visual builder opens a
 * configuration laid out as its author left it.
 *
 *   * The text wins. yaml_content stays the configuration's content; these
 *     columns supply only the layout (positions, group sizes, colors, ids),
 *     which the editor matches onto the graph it parses from the text. The
 *     configs inside `nodes` are a copy, written from the text at every save
 *     and never read back. The graph never stops the text from saving: the
 *     API stores it best effort.
 *   * jsonb, not null, default '[]': every existing version takes '[]' here
 *     and is laid out on open. There is no backfill.
 *   * Each column is checked to be a JSON array, and to be at most 4 MiB
 *     (4,194,304 bytes) as jsonb::text. The size check is a backstop, not the
 *     contract: Postgres prints jsonb with a space after each separator and
 *     numbers in full, so its text is longer than the JSON the API measured
 *     and can't be compared with it. The API's contract bounds each column at
 *     1 MiB of UTF-8 in JSON.stringify's form, and
 *     answers a refusal by any of these checks with 400 invalid_request.
 *   * The table's row-level security and migration 009's default privileges
 *     already cover new columns: nothing is granted and no policy changes.
 *
 * down drops the three columns, and their checks with them.
 */

export const up = (pgm) => {
  pgm.sql(`
    alter table configuration_versions
      add column nodes     jsonb not null default '[]'::jsonb,
      add column edges     jsonb not null default '[]'::jsonb,
      add column pipelines jsonb not null default '[]'::jsonb,
      add constraint ck_configuration_versions_nodes_array     check (jsonb_typeof(nodes) = 'array'),
      add constraint ck_configuration_versions_edges_array     check (jsonb_typeof(edges) = 'array'),
      add constraint ck_configuration_versions_pipelines_array check (jsonb_typeof(pipelines) = 'array'),
      add constraint ck_configuration_versions_nodes_size      check (octet_length(nodes::text) <= 4194304),
      add constraint ck_configuration_versions_edges_size      check (octet_length(edges::text) <= 4194304),
      add constraint ck_configuration_versions_pipelines_size  check (octet_length(pipelines::text) <= 4194304);

    comment on column configuration_versions.nodes is
      'the builder''s nodes, without React Flow''s
       runtime fields: layout the editor matches onto the
       graph it parses from yaml_content, which wins. Each node''s config is a
       copy of the text''s, written at every save and never read back, so it
       is private as the YAML is: never logged, audited or sent to analytics.
       ''[]'' for a version saved before this column, which is laid out on
       open.';
    comment on column configuration_versions.edges is
      'the builder''s edges: id, source, target and type.
       Layout only: yaml_content says what connects to what.';
    comment on column configuration_versions.pipelines is
      'the builder''s pipelines: id, name, signal type and
       color. Layout only: yaml_content''s service.pipelines wins.';

    comment on constraint ck_configuration_versions_nodes_array on configuration_versions is
      'a JSON array (23514 otherwise): the editor reads the column as a list.';
    comment on constraint ck_configuration_versions_edges_array on configuration_versions is
      'a JSON array (23514 otherwise): the editor reads the column as a list.';
    comment on constraint ck_configuration_versions_pipelines_array on configuration_versions is
      'a JSON array (23514 otherwise): the editor reads the column as a list.';
    comment on constraint ck_configuration_versions_nodes_size on configuration_versions is
      'a backstop at 4 MiB of jsonb::text. The real
       bound is the API''s contract, 1 MiB of UTF-8 in JSON.stringify''s form:
       jsonb prints longer (spaces, numbers in full), so the two can''t be
       compared, and this is set well above it.';
    comment on constraint ck_configuration_versions_edges_size on configuration_versions is
      'a backstop at 4 MiB of jsonb::text, as the nodes'' is.';
    comment on constraint ck_configuration_versions_pipelines_size on configuration_versions is
      'a backstop at 4 MiB of jsonb::text, as the nodes'' is.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    alter table configuration_versions
      drop column nodes,
      drop column edges,
      drop column pipelines;
  `);
};

/**
 * The organization's "Public install links" switch (D17d-2 decision 20;
 * Preflight rulings 10, 13 and 14).
 *
 *   * organizations.public_install_links_enabled: whether the organization's
 *     public install links work, D17c-2's Linux Quick Deploy links and
 *     D17d-2's Helm values links alike. True by default, so every existing
 *     organization keeps them. Only an admin changes it (the API's check).
 *     While it is false, no link is made and every existing link's public
 *     download is refused; the links stay and work again once it is true.
 *   * quick_deploy_links.choices is re-commented by kind: a Helm values
 *     link's fields join a Linux link's. No DDL on the column: its check
 *     (an object of at most 16 KiB) holds for both.
 *
 * `organizations` has no row-level security and telflo_platform_runtime already
 * holds select, insert, update and delete on it (migration 009): no grant,
 * policy or definer changes. quick_deploy_link_by_secret_hash is unchanged:
 * the download reads the switch through the scope, after the definer.
 *
 * down drops the column and restores migration 032's comment on choices.
 */

export const up = (pgm) => {
  pgm.sql(`
    alter table organizations
      add column public_install_links_enabled boolean not null default true;

    comment on column organizations.public_install_links_enabled is
      'whether the organization''s public install links work (D17d-2): Linux
       Quick Deploy links and Helm values links. True by default; only an
       admin changes it. While false, no link is made and every link''s
       download is refused; the links stay and work again once it is true.';

    comment on column quick_deploy_links.choices is
      'what the link installs, by kind (D17d-2): a Linux link''s (no kind, or
       kind linux) bundle request''s validated fields: method, arch,
       rootPath, executablePath (null for all-in-one), systemd and envNames;
       a Helm values link''s (kind helm): kind, role, release, namespace and
       envNames. Never a value, a display name or the secret.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    alter table organizations drop column public_install_links_enabled;

    comment on column quick_deploy_links.choices is
      'the bundle request''s validated fields: method, arch, rootPath,
       executablePath (null for all-in-one), systemd and envNames. Never a
       value, a display name or the secret.';
  `);
};

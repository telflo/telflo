import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  // `/` goes to sign-in or the app.
  index("routes/_index.tsx"),
  route("login", "routes/login.tsx"),
  route("register", "routes/register.tsx"),
  route("check-your-email", "routes/check-your-email.tsx"),
  route("verify-email", "routes/verify-email.tsx"),
  route("forgot-password", "routes/forgot-password.tsx"),
  route("reset-password", "routes/reset-password.tsx"),
  // The playground: a sample workspace for a visitor with no account,
  // outside the signed-in layout. The shell's pages are the layout's
  // children; the fleet pages follow the platform's one fleet page, the
  // per-kind fleet paths redirecting there. The full-screen editor is
  // outside the shell, and the blank public editor outside the playground.
  route("playground", "routes/playground.tsx", [
    index("routes/playground._index.tsx"),
    route("flows", "routes/playground.flows.tsx"),
    route("flows/:slug", "routes/playground.flows.$slug.tsx"),
    route("fleet-management", "routes/playground.fleet-management.tsx"),
    route("fleet-management/server/:fleetId", "routes/playground.fleet-management.server.$fleetId.tsx"),
    route("fleet-management/k8s/:fleetId", "routes/playground.fleet-management.k8s.$fleetId.tsx"),
    route("fleet-management/:fleetId", "routes/playground.fleet-management.$fleetId.tsx"),
  ]),
  route("playground/editor/:configurationId?", "routes/playground.editor.tsx"),
  route("public-editor", "routes/public-editor.tsx"),
  // Resource routes. `docs/*` also matches `/docs` itself.
  route("robots.txt", "routes/robots[.]txt.tsx"),
  route("docs/*", "routes/docs.tsx"),
  // Outside the signed-in layout: the invitee may be signed out, or signed in
  // as someone else.
  route("accept-invitation", "routes/accept-invitation.tsx"),
  // Signed-in pages: the layout's loader requires a session for all of them.
  layout("routes/app-layout.tsx", [
    route("app", "routes/configurations.tsx"),
    // `telflo login`'s browser side: its parameters in the fragment.
    route("cli-auth", "routes/cli-auth.tsx"),
    // The signed-in flows gallery and a flow's page, with "Use this flow".
    route("app/flows", "routes/app.flows.tsx"),
    route("app/flows/:slug", "routes/app.flows.$slug.tsx"),
    // The fleet list (the sidebar's Fleet) and a fleet's page, one route for
    // every type of fleet, its tab in `?tab=`.
    route("fleet-management", "routes/fleet-management.tsx"),
    route("fleet-management/:fleetId", "routes/fleet-management.$fleetId.tsx"),
    // A configuration's editor, at a version: one route, so the page stays
    // mounted while its version changes. `/editor/{id}` opens the person's
    // selection, then names it.
    route("editor/:configurationId/:versionId?", "routes/editor.tsx"),
    // The Sidebar's Learning: the library's helper files, for every signed-in
    // person.
    route("library", "routes/library.tsx"),
    // The Sidebar's Variables: the organization's variables, the index, and
    // its variable groups, each group's page by its id. The search stays in
    // the page: no address holds it.
    route("variables", "routes/variables.tsx", [
      index("routes/variables._index.tsx"),
      route("groups", "routes/variables.groups.tsx"),
      route("groups/:variableGroupId", "routes/variables.groups.$variableGroupId.tsx"),
    ]),
    // Settings: the Personal group's four pages, then Organization and, for
    // admins, Service Accounts and an account's page, by its id only.
    // `/settings` itself redirects to Appearance.
    route("settings", "routes/settings.tsx", [
      route("appearance", "routes/settings/appearance.tsx"),
      route("account", "routes/settings/account.tsx"),
      route("editor", "routes/settings/editor.tsx"),
      route("notifications", "routes/settings/notifications.tsx"),
      route("organization", "routes/settings/organization.tsx"),
      route("service-accounts", "routes/settings/service-accounts.tsx"),
      route("service-accounts/:serviceAccountId", "routes/settings/service-accounts.$serviceAccountId.tsx"),
    ]),
    // The Permissions page, for admins of the active organization. "Invited"
    // is its index.
    route("org-admin", "routes/org-admin.tsx", [
      index("routes/org-admin/invited-members.tsx"),
      route("active-members", "routes/org-admin/active-members.tsx"),
      route("deleted-members", "routes/org-admin/deleted-members.tsx"),
    ]),
    // Product admin, for users with the product-admin flag: its loader checks
    // the flag on the server before anything renders. `/product-admin` itself
    // goes to Flows. Its pages are in the nav's order.
    route("product-admin", "routes/product-admin.tsx", [
      route("user-feedback", "routes/product-admin/user-feedback.tsx"),
      route("test-templates", "routes/product-admin/test-templates.tsx"),
      route("test-regex", "routes/product-admin/test-regex.tsx"),
      route("library", "routes/product-admin/library.tsx"),
      route("flows", "routes/product-admin/flows.tsx"),
      route("users", "routes/product-admin/users.tsx"),
      route("product-admins", "routes/product-admin/product-admins.tsx"),
    ]),
  ]),
] satisfies RouteConfig;

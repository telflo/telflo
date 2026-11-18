/**
 * A meta function's arguments as far as the pages read them: root's match,
 * carrying the public URL its loader passes on (D4 decision 5), or null for
 * an unset TELFLO_PUBLIC_WEB_URL.
 *
 *   meta(metaArgs<typeof meta>("https://telflo.example"))
 */
export function metaArgs<Meta extends (args: never) => unknown>(publicWebUrl: string | null): Parameters<Meta>[0] {
  return { matches: [{ id: "root", loaderData: { publicWebUrl } }] } as unknown as Parameters<Meta>[0];
}

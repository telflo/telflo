/*
 * A collector's details' reported attributes (D17b-1 decisions 13 and 24,
 * Preflight ruling 11): what the collector reported of itself (its
 * description's identifying and non-identifying attributes; at most 16 KiB of
 * jsonb, or 256 keys when the opamp-server cut a larger set), as a key/value
 * list sorted by key. The section is `ph-no-capture`, so session replay
 * records none of it; no key or value reaches an attribute.
 */

/** The keys in code-unit order (`Array.prototype.sort`'s, not `localeCompare`'s), so the order is the same in every browser and locale. */
export function sortedAttributeKeys(attributes: Record<string, string>): string[] {
  return Object.keys(attributes).sort();
}

export function CollectorAttributes({ attributes }: { attributes: Record<string, string> | null }) {
  const keys = attributes === null ? [] : sortedAttributeKeys(attributes);
  return (
    <section className="ph-no-capture space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">Reported attributes</h3>
      {attributes === null || keys.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">None reported.</p>
      ) : (
        <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-6 gap-y-1.5 font-mono text-xs">
          {keys.map((key) => (
            <div key={key} className="contents">
              <dt className="break-all text-muted-foreground">{key}</dt>
              <dd className="break-all text-foreground">{attributes[key]}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

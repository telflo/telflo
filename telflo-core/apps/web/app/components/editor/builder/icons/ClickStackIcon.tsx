/*
 * The ClickHouse bars, which ClickStack ships as its mark, for the
 * ClickHouse exporter (D9a decision 10).
 *
 * Source: the ClickHouse repository, `website/images/logo-clickhouse.svg`
 * at commit 12bd453a43819176d25ecf247033f6cb1af54beb (the artwork Simple
 * Icons cites for ClickHouse),
 * https://github.com/ClickHouse/ClickHouse/blob/12bd453a43819176d25ecf247033f6cb1af54beb/website/images/logo-clickhouse.svg
 * License: Apache-2.0 (the ClickHouse repository, Copyright 2016-2022
 * ClickHouse, Inc.). The five bars' coordinates are the file's, without its
 * wordmark; the first bar's red bottom segment is merged into one
 * full-height bar for a monochrome silhouette. ClickHouse is a trademark of
 * ClickHouse, Inc.; Apache-2.0 grants no trademark rights, and the mark
 * names the system the component talks to. Listed in
 * docs/third-party-assets.md.
 *
 * Decorative, so hidden from assistive technology (the card's title names
 * the component).
 */
export function ClickStackIcon({ className }: { className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 30.38 27" xmlns="http://www.w3.org/2000/svg" className={className} fill="currentColor" aria-hidden="true">
      <path d="M0 0h3.376v27H0zM6.751 0h3.376v27H6.751zM13.502 0h3.376v27h-3.376zM20.253 0h3.376v27h-3.376zM27.004 10.969h3.376v5.062h-3.376z" />
    </svg>
  );
}

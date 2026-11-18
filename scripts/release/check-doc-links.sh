#!/usr/bin/env bash
# check-doc-links.sh: every relative link in the repository's Markdown docs
# leads somewhere (D36-2 Ruling 393).
#
#   scripts/release/check-doc-links.sh       (no argument; from anywhere)
#
# The files it reads, at the repository's root: README.md, docs/*.md,
# docs/conventions/*.md, charts/telflo/README.md and deploy/compose/README.md
# (those that exist; none at all is a problem). In each, outside fenced code
# blocks and inline code: every inline link or image ([text](target),
# ![alt](target)), every reference definition ([name]: target) and every
# HTML href="…", src="…" or srcset="…" (its first address). A target with a scheme (https:, mailto:, …) or
# starting with // is skipped; any other is relative and must resolve, from
# the file's own folder (or the root, for one starting with /), to a file or
# folder of the repository: in a git checkout one git lists (tracked, or new
# and not ignored: `git ls-files --cached --others --exclude-standard`), in a
# copy that isn't a checkout (a git archive) one that exists. A #anchor
# (alone: the file itself) must name a heading of its target, which must be
# a Markdown file: GitHub's slug of an ATX heading's text (lower case,
# punctuation dropped but - and _, each space a -, a repeated slug numbered
# -1, -2, …), or an HTML id="…" or name="…" in it.
#
# Offline and quick: it reads the tree's files and asks git for its list,
# nothing else; it needs node. Each problem is a line naming the file, the
# line, the target and why; a summary line ends the run. Exit 0 every link
# resolves, 1 a problem, 2 usage. bash 3.2 compatible.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ "$#" -ne 0 ]; then
  echo "usage: scripts/release/check-doc-links.sh (no argument)" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "check-doc-links: needs node on PATH" >&2
  exit 1
fi

# The list of the repository's files, one a line (empty outside a checkout).
listing=""
if [ "$(git -C "$REPO_DIR" rev-parse --show-toplevel 2>/dev/null)" = "$REPO_DIR" ]; then
  listing="$(mktemp "${TMPDIR:-/tmp}/check-doc-links.XXXXXX")" || exit 1
  trap 'rm -f "$listing"' EXIT
  if ! git -C "$REPO_DIR" ls-files --cached --others --exclude-standard >"$listing"; then
    echo "check-doc-links: git ls-files failed" >&2
    exit 1
  fi
fi

node - "$REPO_DIR" "$listing" <<'JS'
'use strict';
const fs = require('fs');
const path = require('path');

const [root, listing] = process.argv.slice(2);
const DOCS = ['README.md', 'docs/*.md', 'docs/conventions/*.md', 'charts/telflo/README.md', 'deploy/compose/README.md'];

// What exists: git's list (with every folder it implies), or the disk.
let known = null;
const folders = new Set(['']);
if (listing) {
  known = new Set(fs.readFileSync(listing, 'utf8').split('\n').filter(Boolean));
  for (const f of known) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
}
const exists = (rel) => {
  if (known) return known.has(rel) || folders.has(rel);
  return fs.existsSync(path.join(root, rel));
};
const isFile = (rel) => {
  if (known) return known.has(rel);
  try { return fs.statSync(path.join(root, rel)).isFile(); } catch { return false; }
};

// The docs to read, in order.
const docs = [];
for (const pattern of DOCS) {
  if (!pattern.includes('*')) {
    if (fs.existsSync(path.join(root, pattern))) docs.push(pattern);
    continue;
  }
  const dir = path.dirname(pattern);
  let names = [];
  try { names = fs.readdirSync(path.join(root, dir)); } catch { names = []; }
  for (const n of names.filter((n) => n.endsWith('.md')).sort()) {
    if (fs.statSync(path.join(root, dir, n)).isFile()) docs.push(`${dir}/${n}`);
  }
}

// Lines outside fenced code: [lineNumber, text with inline code removed,
// the raw text].
function proseLines(text) {
  const out = [];
  let fence = null;
  text.split('\n').forEach((line, i) => {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (m) {
      if (fence === null) { fence = m[1]; return; }
      if (m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) { fence = null; return; }
    }
    if (fence !== null) return;
    out.push([i + 1, line.replace(/(`+)[^`]*?\1/g, ''), line]);
  });
  return out;
}

// GitHub's anchors in a Markdown file.
const anchorCache = new Map();
function anchors(rel) {
  if (anchorCache.has(rel)) return anchorCache.get(rel);
  const found = new Set();
  const seen = new Map();
  const raw = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const [, line, rawLine] of proseLines(raw)) {
    for (const m of line.matchAll(/\b(?:id|name)="([^"]+)"/g)) found.add(m[1]);
    // A heading's slug keeps its inline code's text (only the backticks go).
    const h = rawLine.match(/^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!h) continue;
    const text = h[1]
      .replace(/<[^>]+>/g, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`/g, '')
      .toLowerCase();
    const slug = text.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    const n = seen.get(slug) || 0;
    seen.set(slug, n + 1);
    found.add(n === 0 ? slug : `${slug}-${n}`);
  }
  anchorCache.set(rel, found);
  return found;
}
const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)|\b(?:href|src|srcset)="([^"\s]+)[^"]*"/g;
let checked = 0;
let problems = 0;
const problem = (msg) => { console.log(`check-doc-links: ${msg}`); problems++; };

for (const doc of docs) {
  const base = path.posix.dirname(doc);
  const text = fs.readFileSync(path.join(root, doc), 'utf8');
  for (const [no, line] of proseLines(text)) {
    for (const m of line.matchAll(LINK)) {
      const target = m[1] || m[2] || m[3];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
      checked++;
      const hash = target.indexOf('#');
      let file = hash === -1 ? target : target.slice(0, hash);
      let anchor = hash === -1 ? '' : target.slice(hash + 1);
      try { file = decodeURIComponent(file); anchor = decodeURIComponent(anchor); } catch {
        problem(`${doc}:${no}: ${target}: not a valid link`);
        continue;
      }
      let rel;
      if (file === '') rel = doc;
      else if (file.startsWith('/')) rel = path.posix.normalize(file.slice(1));
      else rel = path.posix.normalize(path.posix.join(base, file));
      rel = rel.replace(/\/+$/, '');
      if (rel === '.') rel = '';
      if (rel.startsWith('../') || rel === '..') {
        problem(`${doc}:${no}: ${target}: leads outside the repository`);
        continue;
      }
      if (!exists(rel)) {
        problem(`${doc}:${no}: ${target}: no such file or folder in the repository (${rel || '.'})`);
        continue;
      }
      if (hash === -1) continue;
      if (!rel.endsWith('.md') || !isFile(rel)) {
        problem(`${doc}:${no}: ${target}: an anchor on something that isn't a Markdown file`);
      } else if (!anchors(rel).has(anchor)) {
        problem(`${doc}:${no}: ${target}: no heading #${anchor} in ${rel}`);
      }
    }
  }
}
if (docs.length === 0) problem('no Markdown file to check (README.md, docs/*.md, …)');
console.log(`check-doc-links: ${checked} relative links in ${docs.length} files, ${problems} problem(s)`);
process.exit(problems ? 1 : 0);
JS

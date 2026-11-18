# shellcheck shell=bash
# github-tag.sh: a release tag as GitHub holds it (D36-2 Rulings 396 and 399),
# asked of GitHub's API with the job's token. Sourced, never run: by
# scripts/release/verify-tag.sh (the version job, when the checkout holds the
# tag as a lightweight one) and scripts/release/steps.sh github-release (the
# publish job, just before the Release is made).
#
#   telflo_lightweight_hint <tag>
#       prints the `git tag -a` hint for a lightweight tag
#   telflo_github_tag_object <repository> <tag> <commit> <whose> <tmp>
#       GET repos/<repository>/git/ref/tags/<tag> must answer that ref with
#       an object of type `tag`, and GET repos/<repository>/git/tags/<that
#       sha> a tag object named <tag> whose object is the commit <commit>
#       (<whose> names that commit in the messages, e.g. "this checkout's").
#       Returns 0 with TELFLO_GITHUB_TAG_OBJECT set to the tag object's sha;
#       else 1 with TELFLO_GITHUB_PROBLEM set to a message of fixed words,
#       the tag and shas (never the token, never gh's error output).
#
# The repository must be owner/name (GitHub's characters) and then exactly
# telflo/telflo before it goes into a path; the tag must be v<x.y.z> and the
# commit 40 hex (the callers check both first; checked again here). gh
# reads the token from GH_TOKEN (never argv, a file or the output); it runs
# with a configuration folder of <tmp> (no stored login), github.com only,
# no debug output, no other token variable, standard input closed. bash 3.2
# compatible; it sets no shell option.

telflo_lightweight_hint() {
  printf 'a release is an annotated tag (git tag -a %s -m "telflo %s" on main, then git push origin %s)\n' "$1" "${1#v}" "$1"
}

telflo_github_tag_object() {
  local repo="$1" tag="$2" want="$3" whose="$4" dir="$5" answer sha
  TELFLO_GITHUB_TAG_OBJECT=""
  TELFLO_GITHUB_PROBLEM=""
  if ! [[ "$repo" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$ ]] || [ "${repo#*/}" = . ] || [ "${repo#*/}" = .. ]; then
    TELFLO_GITHUB_PROBLEM="GITHUB_REPOSITORY isn't owner/name: GitHub's API isn't asked"
    return 1
  fi
  if [ "$repo" != telflo/telflo ]; then
    TELFLO_GITHUB_PROBLEM="GITHUB_REPOSITORY isn't telflo/telflo: GitHub's API isn't asked"
    return 1
  fi
  if ! [[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || ! [[ "$want" =~ ^[0-9a-f]{40}$ ]]; then
    TELFLO_GITHUB_PROBLEM="the tag isn't v<x.y.z> or the commit isn't 40 hex: GitHub's API isn't asked"
    return 1
  fi
  if [ -z "${GH_TOKEN:-}" ]; then
    TELFLO_GITHUB_PROBLEM="GH_TOKEN isn't set (the job's token, in the step's env): GitHub's API isn't asked"
    return 1
  fi
  if ! command -v gh >/dev/null 2>&1; then
    TELFLO_GITHUB_PROBLEM="no gh: GitHub's API isn't asked"
    return 1
  fi
  if ! mkdir -m 700 "$dir/gh"; then
    TELFLO_GITHUB_PROBLEM="no temporary directory for gh"
    return 1
  fi
  if ! telflo_github_get "$dir" "repos/$repo/git/ref/tags/$tag" "$dir/ref.json"; then
    TELFLO_GITHUB_PROBLEM="GitHub's API didn't answer for refs/tags/$tag: the tag can't be checked"
    return 1
  fi
  answer="$(telflo_github_answer ref "$dir/ref.json" "$tag")"
  case "$answer" in
    "tag "*) sha="${answer#tag }" ;;
    other) TELFLO_GITHUB_PROBLEM="$tag is a lightweight tag on GitHub too: $(telflo_lightweight_hint "$tag")"; return 1 ;;
    *) TELFLO_GITHUB_PROBLEM="GitHub's API answered refs/tags/$tag in an unexpected shape: the tag can't be checked"; return 1 ;;
  esac
  if ! telflo_github_get "$dir" "repos/$repo/git/tags/$sha" "$dir/tag.json"; then
    TELFLO_GITHUB_PROBLEM="GitHub's API didn't answer for $tag's tag object: the tag can't be checked"
    return 1
  fi
  answer="$(telflo_github_answer tag "$dir/tag.json" "$tag" "$sha" "$want")"
  case "$answer" in
    ok) ;;
    name) TELFLO_GITHUB_PROBLEM="the tag object under refs/tags/$tag on GitHub isn't named $tag"; return 1 ;;
    type) TELFLO_GITHUB_PROBLEM="$tag on GitHub doesn't tag a commit"; return 1 ;;
    commit) TELFLO_GITHUB_PROBLEM="$tag on GitHub tags another commit than $whose $want: was it moved?"; return 1 ;;
    *) TELFLO_GITHUB_PROBLEM="GitHub's API answered $tag's tag object in an unexpected shape: the tag can't be checked"; return 1 ;;
  esac
  TELFLO_GITHUB_TAG_OBJECT="$sha"
}

telflo_github_get() { # <tmp> <path> <out>
  env -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN -u GH_HOST -u GH_REPO -u GH_DEBUG -u DEBUG \
    GH_CONFIG_DIR="$1/gh" GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 GH_PAGER=cat NO_COLOR=1 \
    gh api --hostname github.com -H "Accept: application/vnd.github+json" "$2" >"$3" 2>"$1/gh.err" </dev/null
}

# telflo_github_answer ref <json> <tag>: `tag <sha>`, `other` (not a tag object) or `shape`.
# telflo_github_answer tag <json> <tag> <sha> <commit>: ok, name, type, commit or shape.
telflo_github_answer() {
  python3 -I -c '
import json, re, sys
kind, path, tag = sys.argv[1:4]
hex40 = re.compile(r"^[0-9a-f]{40}$")
try:
    with open(path, encoding="utf-8") as handle:
        reply = json.load(handle)
except Exception:
    print("shape"); sys.exit(0)
target = reply.get("object") if isinstance(reply, dict) else None
if not isinstance(target, dict) or not isinstance(target.get("type"), str) \
        or not isinstance(target.get("sha"), str) or not hex40.match(target["sha"]):
    print("shape"); sys.exit(0)
if kind == "ref":
    if reply.get("ref") != "refs/tags/" + tag:
        print("shape")
    elif target["type"] != "tag":
        print("other")
    else:
        print("tag " + target["sha"])
else:
    sha, commit = sys.argv[4:6]
    if reply.get("sha") != sha:
        print("shape")
    elif reply.get("tag") != tag:
        print("name")
    elif target["type"] != "commit":
        print("type")
    elif target["sha"] != commit:
        print("commit")
    else:
        print("ok")
' "$@" 2>/dev/null || echo shape
}

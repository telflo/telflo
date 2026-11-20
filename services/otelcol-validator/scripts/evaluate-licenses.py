#!/usr/bin/env python3
"""Reads pip-licenses' JSON report of an environment holding exactly a lock's
packages and decides whether each package's license is on the allowed list.
`check-licenses.sh` runs it; it isn't meant to be run by hand.

    evaluate-licenses.py <policy.json> <report.json> <lock>

The report comes from `pip-licenses --from=all --format=json --with-system`,
so each package has three sources, each "UNKNOWN" when absent:

1. `License-Expression` (core metadata 2.4, PEP 639): an SPDX expression by
   definition, taken as it is.
2. `License-Metadata`, the free-text `License:` field: taken when it reads as
   an SPDX expression (identifiers joined by AND, OR, WITH and parentheses),
   else when it is one of the common spellings in `SPELLINGS`, else skipped.
3. `License-Classifier`, the trove classifiers' last parts, joined with "; ":
   each mapped to SPDX through `CLASSIFIERS`; several must all be allowed
   (whether they mean "and" or "or" isn't recorded, so the stricter reading).

The first source that gives an expression decides. "BSD License" alone names
no clause count (the four-clause license carries an advertising condition),
so it maps to nothing; a package with no source that maps is "unknown" and
refused, as the npm and Go checks refuse an unknown license. An expression is
evaluated as the npm check does (`scripts/check-licenses.mjs`): OR needs one
allowed side, AND both, WITH's exception is ignored (exceptions only grant).

Every package the lock names must be in the report, once, and nothing else
may be (the environment's own pip aside, which the caller leaves out), so a
package the tool didn't see can't pass unchecked.

Exits 0 when every license is allowed, 1 when one isn't, 2 when the check
itself can't run.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# Trove classifiers (`License :: ... :: <this>`) and what they name in SPDX.
# A classifier missing from this table names no license the check can trust.
CLASSIFIERS: dict[str, str] = {
    "MIT License": "MIT",
    "MIT No Attribution License (MIT-0)": "MIT-0",
    "ISC License (ISCL)": "ISC",
    # Taken as 2.0: 1.0 and 1.1 are long out of use on PyPI.
    "Apache Software License": "Apache-2.0",
    "Python Software Foundation License": "PSF-2.0",
    "The Unlicense (Unlicense)": "Unlicense",
    "CC0 1.0 Universal (CC0 1.0) Public Domain Dedication": "CC0-1.0",
    "Zero-Clause BSD (0BSD)": "0BSD",
    "Blue Oak Model License (BlueOak-1.0.0)": "BlueOak-1.0.0",
    "SIL Open Font License 1.1 (OFL-1.1)": "OFL-1.1",
    # Not allowed, named so the refusal says what they are.
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "GNU General Public License v2 (GPLv2)": "GPL-2.0-only",
    "GNU General Public License v2 or later (GPLv2+)": "GPL-2.0-or-later",
    "GNU General Public License v3 (GPLv3)": "GPL-3.0-only",
    "GNU General Public License v3 or later (GPLv3+)": "GPL-3.0-or-later",
    "GNU Lesser General Public License v2 (LGPLv2)": "LGPL-2.0-only",
    "GNU Lesser General Public License v2 or later (LGPLv2+)": "LGPL-2.0-or-later",
    "GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0-only",
    "GNU Lesser General Public License v3 or later (LGPLv3+)": "LGPL-3.0-or-later",
    "GNU Affero General Public License v3": "AGPL-3.0-only",
    "GNU Affero General Public License v3 or later (AGPLv3+)": "AGPL-3.0-or-later",
    "Eclipse Public License 2.0 (EPL-2.0)": "EPL-2.0",
    "Server Side Public License (SSPL)": "SSPL-1.0",
}

# Free-text `License:` values seen in the wild that aren't SPDX but name one
# license unambiguously.
SPELLINGS: dict[str, str] = {
    "MIT License": "MIT",
    "Apache 2.0": "Apache-2.0",
    "Apache License 2.0": "Apache-2.0",
    "Apache License, Version 2.0": "Apache-2.0",
    "Apache Software License 2.0": "Apache-2.0",
    "3-Clause BSD License": "BSD-3-Clause",
    "BSD 3-Clause License": "BSD-3-Clause",
    "BSD 3-Clause": "BSD-3-Clause",
    "2-Clause BSD License": "BSD-2-Clause",
    "BSD 2-Clause License": "BSD-2-Clause",
    "ISC License": "ISC",
    "Python Software Foundation License": "PSF-2.0",
}

UNKNOWN = "UNKNOWN"
_IDENTIFIER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+-]*")
_TOKEN_RE = re.compile(r"\(|\)|[^\s()]+")


class Unparseable(Exception):
    pass


def _parse(expression: str) -> list[str]:
    """The expression's tokens, or Unparseable when it isn't SPDX-shaped."""
    tokens = _TOKEN_RE.findall(expression)
    position = 0

    def term() -> None:
        nonlocal position
        if position >= len(tokens):
            raise Unparseable
        token = tokens[position]
        position += 1
        if token == "(":
            either()
            if position >= len(tokens) or tokens[position] != ")":
                raise Unparseable
            position += 1
            return
        if token.upper() in ("AND", "OR", "WITH", ")") or not _IDENTIFIER_RE.fullmatch(token):
            raise Unparseable
        if position < len(tokens) and tokens[position].upper() == "WITH":
            if position + 1 >= len(tokens) or not _IDENTIFIER_RE.fullmatch(tokens[position + 1]):
                raise Unparseable
            position += 2

    def either() -> None:
        nonlocal position
        term()
        while position < len(tokens) and tokens[position].upper() in ("AND", "OR"):
            position += 1
            term()

    either()
    if position != len(tokens):
        raise Unparseable
    return tokens


def is_spdx(expression: str) -> bool:
    try:
        _parse(expression)
    except Unparseable:
        return False
    return True


def is_allowed(expression: str, allowed: set[str]) -> bool:
    """OR needs one allowed side, AND both; a trailing `+` is dropped and
    WITH's exception ignored, as `scripts/check-licenses.mjs` does."""
    try:
        tokens = _parse(expression)
    except Unparseable:
        return False
    position = 0

    def term() -> bool:
        nonlocal position
        token = tokens[position]
        position += 1
        if token == "(":
            result = either()
            position += 1  # ")"
            return result
        if position < len(tokens) and tokens[position].upper() == "WITH":
            position += 2
        return token.removesuffix("+") in allowed

    def either() -> bool:
        nonlocal position
        result = conjunction()
        while position < len(tokens) and tokens[position].upper() == "OR":
            position += 1
            right = conjunction()
            result = result or right
        return result

    def conjunction() -> bool:
        nonlocal position
        result = term()
        while position < len(tokens) and tokens[position].upper() == "AND":
            position += 1
            right = term()
            result = result and right
        return result

    return either()


def license_of(package: dict) -> tuple[str | None, str]:
    """The package's SPDX expression and where it came from, or (None, why)."""
    expression = (package.get("License-Expression") or UNKNOWN).strip()
    if expression != UNKNOWN:
        return expression, "expression"
    metadata = (package.get("License-Metadata") or UNKNOWN).strip()
    if metadata != UNKNOWN:
        if is_spdx(metadata):
            return metadata, "metadata"
        if metadata in SPELLINGS:
            return SPELLINGS[metadata], "metadata"
    classifiers = (package.get("License-Classifier") or UNKNOWN).strip()
    if classifiers != UNKNOWN:
        names = [name.strip() for name in classifiers.split(";") if name.strip()]
        mapped = [CLASSIFIERS.get(name) for name in names]
        if names and all(mapped):
            joined = " AND ".join(dict.fromkeys(mapped))  # type: ignore[arg-type]
            return joined, "classifier"
    sources = ", ".join(
        f"{label} {value!r}"
        for label, value in (("metadata", metadata), ("classifiers", classifiers))
        if value != UNKNOWN
    )
    return None, sources or "no license information"


def normalise(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def lock_names(lock: Path) -> set[str]:
    """The packages a pip-compile lock pins (`name==version`, or
    `name @ url`), normalised."""
    names = set()
    for line in lock.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(==|@)", line)
        if match:
            names.add(normalise(match.group(1)))
    return names


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: evaluate-licenses.py <policy.json> <report.json> <lock>", file=sys.stderr)
        return 2
    policy_path, report_path, lock_path = (Path(arg) for arg in argv)
    try:
        allowed = set(json.loads(policy_path.read_text(encoding="utf-8"))["allowed"])
        report = json.loads(report_path.read_text(encoding="utf-8"))
        pinned = lock_names(lock_path)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"ERROR: the check can't run: {type(error).__name__}: {error}", file=sys.stderr)
        return 2
    if not allowed or not isinstance(report, list) or not pinned:
        print("ERROR: an empty policy, report or lock: nothing would be checked", file=sys.stderr)
        return 2

    if not all(isinstance(package, dict) and isinstance(package.get("Name"), str) for package in report):
        print("ERROR: pip-licenses' report has an entry without a package name", file=sys.stderr)
        return 2
    # One entry per package: a second under the same name (as normalised)
    # would replace the first, which would then go unchecked.
    reported: dict[str, dict] = {}
    duplicated = set()
    for package in report:
        key = normalise(package["Name"])
        if key in reported:
            duplicated.add(key)
        reported[key] = package
    if duplicated:
        print(f"ERROR: pip-licenses' report names {', '.join(sorted(duplicated))} more than once", file=sys.stderr)
        return 2
    missing, extra = sorted(pinned - set(reported)), sorted(set(reported) - pinned)
    if missing or extra:
        print(f"ERROR: pip-licenses' report doesn't match {lock_path.name}:", file=sys.stderr)
        for name in missing:
            print(f"  pinned but not reported: {name}", file=sys.stderr)
        for name in extra:
            print(f"  reported but not pinned: {name}", file=sys.stderr)
        return 2

    disallowed = 0
    print(f"Python package licenses ({lock_path.name}):")
    for key in sorted(reported):
        package = reported[key]
        label = f"{package['Name']} {package['Version']}"
        expression, source = license_of(package)
        if expression is None:
            print(f"  {label:<56} unknown ({source})  <- NOT ALLOWED")
            disallowed += 1
        elif is_allowed(expression, allowed):
            print(f"  {label:<56} {expression} ({source})")
        else:
            print(f"  {label:<56} {expression} ({source})  <- NOT ALLOWED")
            disallowed += 1

    if disallowed:
        print("")
        print(f"ERROR: {disallowed} package license(s) above are not on the allowed list in {policy_path}.")
        print("Only a license that allows redistribution may be added to that list.")
        return 1
    print(f"All {len(reported)} Python package licenses are allowed.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

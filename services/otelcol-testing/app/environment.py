"""The environment a run's processes get (D14a spec decision 5: the
environment allowlist).

A collector expands `${env:VAR}` at load time, so any variable it holds can
be read back through a run's output or logs. The run's child process and its
collector get only these variables from the service's environment; anything
else the service holds (a future operator-injected secret, the telemetry
endpoint) is stripped before exec. The shared secret is never in the
service's environment to begin with (app/settings.py). Add to this set only
with a deliberate reason: anything added becomes readable by any text a
person runs. `app/sandbox_env.py` (D14a Task 4) adds the sandbox's fixed
overrides on top of it for the collector.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

ALLOWED_PARENT_ENV: frozenset[str] = frozenset(
    {
        # The collector and its loader resolve shared libraries through it.
        "PATH",
        # Locale and home directory: many libraries expect them.
        "HOME",
        "LANG",
        "LC_ALL",
        # Temporary files go under the run's own scratch space.
        "TMPDIR",
        "TEMP",
        "TMP",
    }
)


def allowed(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    """`environ` (the service's own by default) filtered to the allowlist."""
    source = os.environ if environ is None else environ
    return {name: value for name, value in source.items() if name in ALLOWED_PARENT_ENV}

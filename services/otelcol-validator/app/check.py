"""The check's child process: `python -m app.check`.

The service starts one per check, in its own process group, with the
collector's allowlisted environment (never the service's secret), and kills
the whole group at the check's deadline. It reads one request from stdin,

    {"binary": <path>, "yaml": <text>, "directory": <the check's own
     temporary directory>, "timeout_seconds": <the collector's limit>,
     "organization_variables": <name to value, filled in first>}

runs the whole check (`app.runner.check_text`: the pre-processing, the
collector, the stderr parse), and writes one answer to stdout:

    {"valid", "errors", "requirements", "outcome"}

or, when it fails, only how: `{"failure": <exception type name>}`, with
`"unavailable": true` when the collector couldn't be run (an OSError). It
writes nothing else anywhere: its stderr goes nowhere, and an exception's
message (which could quote the text) never leaves it.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from app.runner import check_text


def answer_for(request: dict) -> dict:
    try:
        result = asyncio.run(
            check_text(
                Path(request["binary"]),
                request["yaml"],
                timeout_seconds=int(request["timeout_seconds"]),
                directory=request["directory"],
                organization_variables=request.get("organization_variables"),
            )
        )
    except OSError as error:
        return {"failure": type(error).__name__, "unavailable": True}
    except Exception as error:  # the type only: its message could quote the text
        return {"failure": type(error).__name__}
    return {
        "valid": result.valid,
        "errors": result.errors,
        "requirements": result.requirements,
        "outcome": result.outcome,
    }


def main() -> int:
    try:
        request = json.loads(sys.stdin.buffer.read())
    except Exception as error:
        answer = {"failure": type(error).__name__}
    else:
        answer = answer_for(request)
    sys.stdout.buffer.write(json.dumps(answer).encode("utf-8"))
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())

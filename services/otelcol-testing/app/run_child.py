"""The run's child process: `python -m app.run_child` (the validator's
`app/check.py` pattern, D13b ruling 27).

The service starts one per run, in its own session and process group, with
the allowlisted environment (never the service's secret, which is in no
environment at all), and kills the whole group at the run's deadline. It
reads one request from stdin (app/run.py's `RunRequest`, as JSON), runs it
(`app.run.execute`), and writes one answer to stdout, or, when it fails,
only how: `{"failure": <exception type name>}`, with `"unavailable": true`
only when the collector's binary couldn't be executed (`CollectorExecFailed`:
the exec's own errnos, Ruling 29; any other error, an OSError such as a
timeout, a full disk or a fork that failed included, is a plain failure:
Ruling 27). It writes nothing else anywhere: its stderr goes
nowhere, and an exception's message (which could quote the text) never
leaves it.
"""

from __future__ import annotations

import asyncio
import json
import sys

from app.run import CollectorExecFailed, RunRequest, execute


def answer_for(document: dict) -> dict:
    try:
        return asyncio.run(execute(RunRequest.from_json(document)))
    except CollectorExecFailed as error:
        return {"failure": error.kind, "unavailable": True}
    except Exception as error:  # the type only: its message could quote the text
        return {"failure": type(error).__name__}


def main() -> int:
    try:
        document = json.loads(sys.stdin.buffer.read())
        if not isinstance(document, dict):
            raise TypeError("not an object")
    except Exception as error:
        answer = {"failure": type(error).__name__}
    else:
        answer = answer_for(document)
    sys.stdout.buffer.write(json.dumps(answer, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())

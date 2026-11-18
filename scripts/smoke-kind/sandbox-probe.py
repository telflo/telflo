# The kind smoke's HTTP probe from inside a sandboxed service
# (scripts/smoke-kind.sh; D33-1 spec decision 35, Preflight ruling 19):
# read by the service's own Python from its standard input through
# `kubectl exec -i <pod> -- python - <url>...`, it asks each URL with
# urllib and prints one line a URL: `<url> reached <status>` when anything
# answered (an HTTP error status included), `<url> refused <why>` otherwise
# (a timeout, a name that doesn't resolve, a refused connection). It sends
# nothing but a plain GET.
import sys
import urllib.error
import urllib.request

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for url in sys.argv[1:]:
    try:
        with opener.open(url, timeout=4) as reply:
            print(url, "reached", reply.status)
    except urllib.error.HTTPError as error:
        print(url, "reached", error.code)
    except Exception as error:  # noqa: BLE001 - every other outcome is a refusal here
        reason = getattr(error, "reason", None)
        print(url, "refused", type(reason).__name__ if reason is not None else type(error).__name__)

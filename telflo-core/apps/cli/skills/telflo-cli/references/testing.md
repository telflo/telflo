# Writing telflo test specs

## The spec file

```yaml
signal: logs                  # traces | metrics | logs
pipeline: logs/in             # the pipeline under test: <signal> or <signal>/<name> (a service.pipelines key)
duration: 5                   # seconds, 1 to 60 (default 5)
collector_version: 0.147.0    # optional; see the precedence below
distribution: otelcol-contrib # optional
sample: ./sample.json         # a file, relative to the spec's folder (at most 1 MiB)
# sample_text: "..."          # or the sample inline: exactly one of the two
rules:                        # 1 to 20 (optional with --saved)
  - name: every record survives
    context: log              # log | resource | scope (logs); span | spanevent | resource | scope (traces);
                              # metric | datapoint | resource | scope (metrics)
    quantifier: count         # all | any | none | count | distinct
    condition: "true"
    count: { operator: eq, value: 10 }   # eq | ne | gt | gte | lt | lte | between (value2 with between)
```

The collector it runs on: the `--collector-version` and `--distribution`
flags always win; then
- **a local file with `--config <id>`** (`-f file --config <id>`): the
  configuration's pin, over the spec's `collector_version` and
  `distribution`;
- **a stored version** (`--config <id>` alone): the spec's
  `collector_version` and `distribution`, over the stored version's pin;
- **a local file alone** (`-f file`): the spec's fields;
- otherwise the server's default.

Prefer the pin (leave the spec's two fields out, and pass `--config <id>`
with a local file): a test that passes on another collector says little
about the one the configuration runs on.

Each rule is an OTTL rule on the run's output:

- every quantifier but `distinct` takes a boolean OTTL `condition`;
- `distinct` takes an `expression` (a value expression whose distinct
  values are counted; composite keys with `Concat([...], "|")`), a `count`,
  and an optional `condition` filtering the records first;
- `count` and `distinct` need a `count`; the others take none;
- a rule takes only `name`, `context`, `quantifier`, `condition`,
  `expression` and `count`; a name is at most 200 characters.

The CLI checks every rule before anything is sent, as the server would: a
bad one is exit 2 naming it (`rules[2].count.value`, say). The spec's
optional `name` is read but not sent.

## Rules for good tests

1. **Assert the class of behaviour, not the sample's literals.** An exact
   value belongs only in the untouched control and in values the
   configuration itself writes.
2. **Always include three controls:** (a) the number of records that
   survive (`condition: "true"`, quantifier `count`, the expected number);
   (b) positive evidence the processor acted; (c) a record the processor
   must not touch, asserted to come through unchanged.
3. **No tautologies.** `X == X` or `Y == nil or Y != nil` prove nothing; a
   bare `"true"` belongs only in the count control.
4. **Escaping:** OTTL takes one level of backslashes: write `\\d`, `\\b`,
   or prefer classes (`[0-9]`, `[.]`, `[+]`). A single-escaped regex
   matches nothing and would pass a `none` rule vacuously (`telflo ottl
   lint` reports it).
5. **Quantifiers:** `none` for absence and leak checks; `count` with `eq`
   for exact counts; `all` is true over zero records (pair it with a count
   control); `distinct` for cardinality.
6. **The sample matches the pipeline's receiver:** OTLP JSON for an OTLP
   receiver, raw lines for `filelog`, syslog lines for `syslog`.
7. **Variables:** the organization's variables (`${org:NAME}`) are filled
   in for the run, as for validation.

## Saving rules to the Validation tab, and running saved rules

The web app's Testing panel has a **Validation** tab: the rules saved on a
configuration version, one set per YAML pipeline. A plain `telflo test`
leaves it alone (the run shows under the runs only). Two flags connect the
two; both need a stored version (`--config`), never `-f`:

- `telflo test --spec spec.yaml --config <id> --save` saves the spec's
  rules as the version's rules for `pipeline`, then runs the saved rules.
  **Use it once the rules pass**, so the user sees them in the Validation
  tab and can run them again there. The API replaces only the rules it
  saved before (API-owned); rules people wrote are kept.
- `telflo test --spec spec.yaml --config <id> --saved` runs the rules
  already saved (written in the web app, or by an earlier `--save`). The
  spec needs only `signal`, `pipeline` and a sample; its rules are ignored,
  with a note. With nothing saved, the API's refusal is exit 1.
- `telflo config rules <id> [--version <n>]` shows what is saved.

A `pipeline` the configuration doesn't have is refused with the API's
words (exit 1).

## Reading the results

`--json` prints the whole run. `results[i]` is a rule's result, in the
spec's order (or matched to the saved rules by id), with the rule's
`name`, `passed`, and `error` (why it couldn't be judged), `advisory` and
`detail` (`no_match`, `unexpected_match`, `record_mismatch`,
`distinct_mismatch`, with counts). The run's `status`: `succeeded` (exit
0); `validation_failed` (a rule failed; exit 4); `failed` (the collector or
the sandbox failed: read `errorMessage`; exit 4). `--output <file>` saves
what the collector exported.

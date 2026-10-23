# Output and exit-code contract

## Contents

1. Stream and TTY matrix
2. JSON conventions
3. Error object
4. Exit-code table template
5. Machine output in shipped CLIs

## 1. Stream and TTY matrix

| Output | Human mode, terminal | Human mode, piped / CI | `--json` mode |
|---|---|---|---|
| Requested result | stdout, table with color | stdout, table without color | stdout, one JSON document |
| Error | stderr, text | stderr, text | stdout, `{"error": {...}}`; human hint may repeat on stderr |
| Progress, spinners | stderr, animated | stderr, plain lines or nothing | stderr, plain lines or nothing |
| Warnings, deprecation notices | stderr | stderr | stderr |
| Update hints, first-run notices | stderr | none | none |
| Prompts | allowed when stdin is a terminal | never; fail naming the flag | never |
| Pager | allowed | never | never |
| Color | on unless `NO_COLOR`, `--no-color`, `TERM=dumb` | off unless `FORCE_COLOR` | off |

Why errors move to stdout under `--json`: stderr also carries progress and warnings, so a JSON error there cannot be parsed reliably, and a caller reading stdout alone would see nothing on failure. With one document on stdout either way, `| jq` and agents parse every run; the exit code says which shape arrived. clig.dev's "errors to stderr" stays the rule in human mode.

## 2. JSON conventions

- One documented shape per command, keyed by the API's own field names, so CLI and API docs agree. Publish it as JSON Schema.
- Additive only within a major version. Renaming, retyping or removing a field is breaking.
- Bare `--json` returns a documented default field set; `--json all` returns full objects; `--json id,status` returns only the named fields.
- Three top-level shapes, each with its own schema: success, `{"error": {...}}`, and bulk `{"data": [...], "errors": [...]}`.
- Every list uses one envelope from v1, field selection included:

  ```json
  {"data": [{"id": "inv_1", "status": "open"}], "has_more": true, "next_cursor": "c_42"}
  ```

  GitHub's CLI returns bare arrays; borrow its field selection, not its list shape.
- Newline-delimited JSON only behind `--format ndjson`, mutually exclusive with `--json`, for streams: each line has a `type` (`event`, `progress`, `error`), and a fatal error is the last line before a non-zero exit.
- Async mutations return the operation whether the command waited or not; the waited result nests inside it:

  ```json
  {"operation_id": "op_9", "state": "succeeded", "result": {"id": "dep_3", "url": "https://app.example.com"}}
  ```
- Timestamps in RFC 3339 UTC; IDs as strings; absent values as `null`, never keys that appear and disappear.

## 3. Error object

```json
{
  "error": {
    "code": "invoice_already_voided",
    "message": "Invoice in_123 is already voided.",
    "request_id": "req_8f2a",
    "operation_id": null,
    "retry": "never",
    "docs_url": "https://docs.example.com/errors/invoice_already_voided",
    "hint": "Run `acme invoices get in_123` to see its state."
  }
}
```

- `code` comes from the API's error taxonomy; client-side failures (usage, config, auth missing) get their own documented codes.
- `retry` is one of `safe`, `resume`, `never`, mirroring the exit-code classes below.
- Bulk operations return per-item results (`{"data": [...], "errors": [...]}`) with the partial-failure exit code.

## 4. Exit-code table template

| Code | Meaning | Caller action |
|---|---|---|
| 0 | Success, including an idempotent no-op | continue |
| 1 | Failure not covered below | stop, read the error |
| 2 | Usage error: unknown flag, missing argument | fix the invocation; never retry |
| 3 | Not found | branch |
| 4 | Authentication required or token expired | re-authenticate |
| 5 | Safe to rerun: rate limited, or transient failure before the server accepted the request | rerun the same command with backoff |
| 6 | Outcome unknown: wait timeout, connection lost after sending | `wait <operation-id>`; never rerun a create without your own `--idempotency-key` |
| 7 | Partial failure in a bulk operation | read per-item results |
| 130 | Interrupted (128 + SIGINT); the CLI detached and printed the resume command | resume or stop |

- Codes 3-7 are illustrative; keep the set small and publish it as a help topic.
- Map transport and HTTP outcomes once: DNS, connect or TLS failure before sending, 429, and 503 with `Retry-After` → 5; any other 5xx, or a timeout after sending a non-idempotent call → 6, unless the request carried a caller-controlled idempotency key (then 5). A synchronous create that ends in 6 has no operation ID: the caller checks with `get` or `list`.
- SIGTERM (a cancelled CI job) follows the same detach behavior as Ctrl-C, exit 143.
- Code 2 follows the getopt/argparse usage convention. GitHub's CLI uses 2 for "cancelled" and 4 for "authentication required": pick one meaning for 2 and document it.
- Avoid BSD sysexits (64-78) as a promise: current FreeBSD documentation marks them deprecated.
- Keep 126-127 and 128+N for their shell meanings. AWS CLI v2 ships 252-255, which shell scripts testing `$? -gt 128` misread as signals.
- Test each code. Known regressions: an auth-status command returning 0 on an expired token, a login returning 1 on success when an env token was set.

## 5. Machine output in shipped CLIs

| CLI | Machine output | In-CLI filter |
|---|---|---|
| GitHub CLI | `--json <fields>`; bare `--json` lists fields | `--jq`, `--template` |
| kubectl | `-o json/yaml/jsonpath` | jsonpath |
| AWS CLI | `--output json/text/table` | `--query` (JMESPath) |
| Heroku | `--json` | external |
| flyctl | `--json` on many commands; not on `deploy` | external |
| Stripe | JSON by default | external |

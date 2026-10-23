# Command layer patterns

## Contents

1. Grammar in shipped CLIs
2. Layering in shipped CLIs
3. Worked redesign: "one command per REST endpoint"
4. Negative example

## 1. Grammar in shipped CLIs

| CLI | Grammar | Example |
|---|---|---|
| GitHub CLI | noun verb | `gh pr list`, `gh issue create` |
| Heroku | topic:command | `heroku apps:create` |
| Stripe | resource operation | `stripe customers create` |
| Twilio | generated `api:<product>:<resource>:<op>` | `twilio api:core:messages:list` |
| Docker | noun verb | `docker container create` |
| kubectl | verb TYPE NAME | `kubectl get pods pod1` |

- clig.dev: either order works, noun-verb is more common; the binding rule is consistent verbs across object types.
- Heroku style guide: topics are plural nouns, commands are verbs, single lowercase words, and the bare topic lists - never a separate `config:list`.
- kubectl's verb-noun order works because `get`, `apply`, `delete` and `describe` apply to every resource type, including user-defined ones.

## 2. Layering in shipped CLIs

| CLI | Curated workflow layer | Resource layer | Raw escape hatch |
|---|---|---|---|
| Stripe | `listen`, `trigger`, `logs tail`, `fixtures` | resource commands (`stripe customers create`) | `stripe get/post/delete` with `--expand`, `--idempotency`, `--stripe-version`; sandbox unless `--live` |
| Twilio | `phone-numbers:update`, `email:send` | `twilio api:*`, generated from OpenAPI | covered by the generated layer |
| GitHub CLI | `pr`, `issue`, `repo`, `run` | none | `gh api` with `--paginate`, `--jq`, path placeholders, GraphQL |

- Generated layer: full coverage and zero drift; costs API-shaped names, path-shaped flags, version namespaces in the UX, and a second tree to test.
- Curated layer: memorable verbs, multi-call workflows, better errors; costs coverage gaps.
- Raw escape hatch: covers the gaps on day one, inherits auth and output flags, gives agents a predictable fallback.
- Agent-era input variant: Google's Workspace CLI accepts a raw JSON payload beside convenience flags; its author argues raw payloads suit agents better than bespoke flags, and recommends supporting both. Name the input flag apart from the `--json` output flag.

## 3. Worked redesign: "one command per REST endpoint"

Input: a payments-adjacent API with 140 endpoints across 22 resources; product asks for a CLI that mirrors every endpoint 1:1. Interview: developers and CI are the main audiences, agents rising; the OpenAPI spec is complete but not CI-gated; jobs include webhook testing against localhost and streaming request logs; six-week deadline, two engineers.

Output:

- Jobs first: `login`, `listen --forward-to localhost:3000`, `trigger <event>`, `logs tail`, `invoices create/list/get/void`, `customers list/get`, `keys rotate`. Twelve curated commands cover the jobs product and support named most often.
- Day-one escape hatch: `acme api get /v1/payouts?limit=5`, `acme api post /v1/refunds -d charge=ch_1`, inheriting auth, `--json`, `--paginate`, `--idempotency-key`, and the severity table (`acme api post /v1/invoices/in_1/void` asks for the same confirmation as `acme invoices void in_1`).
- Generated resource layer: parked as the starved option. Promotion trigger written into the spec: the OpenAPI spec gains a CI gate, and escape-hatch usage shows sustained demand for endpoints outside the curated set.
- Answer to product: every endpoint is reachable on day one through `acme api`; the curated commands carry the jobs; the mirror is a later layer underneath, never the top-level grammar.

## 4. Negative example

```
# ✗ Bad - API paths and versions leak into every command; no job is visible
acme v1-customers-customer_id-sources-source_id-verify-post --customer-id cus_1 --source-id src_1

# ✓ Good - job-shaped command, raw path still reachable
acme sources verify src_1 --customer cus_1
acme api post /v1/customers/cus_1/sources/src_1/verify
```

# Review checklist - full pass/fail items

Walk all eight dimensions in order. Each item is a concrete pass/fail check, not a prompt for commentary. A failed item becomes a finding; bucket it per SKILL.md step 4 (Must-change when a written rule or precedent is cited, Improvement otherwise).

## Table of Contents

- [1. Resource modeling and URI naming](#1-resource-modeling-and-uri-naming)
- [2. HTTP method semantics](#2-http-method-semantics)
- [3. Status-code correctness](#3-status-code-correctness)
- [4. Field-naming consistency](#4-field-naming-consistency)
- [5. Pagination](#5-pagination)
- [6. Filtering, sorting, field selection](#6-filtering-sorting-field-selection)
- [7. Error shape consistency](#7-error-shape-consistency)
- [8. Backward compatibility](#8-backward-compatibility)
- [Sibling-boundary checks - one line each in the report](#sibling-boundary-checks-one-line-each-in-the-report)

## 1. Resource modeling and URI naming

- [ ] Resources are nouns, never verbs - no `/getUser`, `/createUser`, or `POST /users?action=delete`.
- [ ] Collection URIs are plural: `/users`, not `/user`.
- [ ] URIs are lowercase, with hyphens for multi-word resources: `/shipping-addresses`.
- [ ] Nesting stops at 2-3 levels (`/users/{id}/orders/{orderId}`); anything deeper is a finding.
- [ ] One URI template holds across the surface: `/{version}/{resource}/{id}/{sub-resource}/{sub-id}`.
- [ ] Non-CRUD operations use a deliberate, consistent convention (a custom-method suffix or a sub-resource), not a different improvisation per endpoint.

Diagnostic, not a gate: the Richardson Maturity Model grades how RESTful the surface is.

| Level | Description                                                                    |
| ----- | ------------------------------------------------------------------------------ |
| 0     | Single URI and method                                                          |
| 1     | Per-resource URIs                                                              |
| 2     | Proper HTTP verbs - where this checklist operates and where most real APIs sit |
| 3     | Hypermedia-driven navigation                                                   |

Level 2 is the pragmatic target when clients deploy in lockstep with the server. Level 3 pays off mainly for public APIs whose client update cycles nobody controls. Use the model to communicate where the surface stands, never to demand Level 3.

## 2. HTTP method semantics

| Method       | Safe | Idempotent | Use                                                       |
| ------------ | ---- | ---------- | --------------------------------------------------------- |
| GET          | yes  | yes        | retrieve                                                  |
| POST         | no   | no         | create / non-idempotent action                            |
| PUT          | no   | yes        | full replace                                              |
| PATCH        | no   | no         | partial update                                            |
| DELETE       | no   | yes        | remove (first call 204, later calls 404 - same end state) |
| HEAD/OPTIONS | yes  | yes        | metadata / allowed methods                                |

- [ ] No GET has side effects.
- [ ] No POST performs an operation that is actually idempotent (a full replace, a delete).
- [ ] No PUT accepts a partial object - PUT demands the full replacement; partial updates are PATCH. Reject the rationalization "PATCH is complicated, let's just use PUT": PUT then forces every client to send the full object every time.
- [ ] DELETE is idempotent in effect: repeating it converges on the same end state.
- [ ] Method choice is uniform for the same operation shape across resources - if one resource updates via PATCH, its siblings don't update via POST.

## 3. Status-code correctness

Expected codes:

| Status                  | Meaning                                   |
| ----------------------- | ----------------------------------------- |
| 200                     | GET/PATCH/PUT success                     |
| 201 + `Location` header | POST create                               |
| 202                     | async accept                              |
| 204                     | DELETE success                            |
| 400                     | malformed request                         |
| 401                     | not authenticated                         |
| 403                     | authenticated but forbidden               |
| 404                     | not found                                 |
| 405                     | method not supported                      |
| 409                     | conflict - duplicate or version mismatch  |
| 422                     | syntactically valid, semantically invalid |
| 429                     | rate limited, paired with `Retry-After`   |
| 500/502/503/504         | server side                               |

- [ ] No 200 carrying an error object in the body - the single worst status-code finding.
- [ ] 400 vs 422 split correctly: 400 for malformed requests, 422 for well-formed requests that fail semantic validation.
- [ ] 401 vs 403 split correctly: 401 for missing or invalid authentication, 403 for an authenticated caller lacking permission.
- [ ] Every POST-create returns 201 with a `Location` header, not a bare 200.
- [ ] 429 responses carry `Retry-After`.
- [ ] The same failure condition maps to the same status code on every endpoint.

Secondary items - check when present, flag inconsistency, don't demand adoption:

- `Accept`/`Content-Type` negotiation.
- `ETag` with `If-None-Match`/`If-Match` and `412 Precondition Failed` for optimistic concurrency.
- `Cache-Control` on cacheable reads.

## 4. Field-naming consistency

| Element         | Convention                                           | Example                            |
| --------------- | ---------------------------------------------------- | ---------------------------------- |
| Query params    | camelCase or snake_case - pick one, apply everywhere | `?sortBy=createdAt&pageSize=20`    |
| Response fields | the same casing as query params, everywhere          | `{ createdAt, updatedAt, taskId }` |
| Boolean fields  | `is`/`has`/`can` prefix                              | `isComplete`, `hasAttachments`     |
| Enum values     | UPPER_SNAKE                                          | `"IN_PROGRESS"`, `"COMPLETED"`     |

- [ ] One casing convention across every endpoint's parameters and response fields. `created_at` on one endpoint and `createdAt` on a sibling is a top-priority finding regardless of which style is "correct" - consistency of the choice is the check, not the choice itself.
- [ ] Booleans carry an `is`/`has`/`can` prefix consistently.
- [ ] Enum casing is uniform across all enums in the surface.
- [ ] The same concept has the same name everywhere - not `user_id` here and `userId` (or `owner`) there.
- [ ] No endpoint returns a different response shape depending on runtime conditions - shape inconsistency and naming inconsistency are the same defect at different granularity.

## 5. Pagination

Strategy trade-offs (the review checks the choice was deliberate and matches the data shape):

| Feature                  | Offset                | Page                | Cursor           | Keyset                          |
| ------------------------ | --------------------- | ------------------- | ---------------- | ------------------------------- |
| Performance              | poor at large offsets | poor                | excellent        | excellent                       |
| Random access            | yes                   | yes                 | no               | no                              |
| Total count              | yes                   | yes                 | no               | optional                        |
| Consistency under writes | poor                  | poor                | excellent        | excellent                       |
| Complexity               | simple                | simple              | medium           | medium                          |
| Best for                 | small datasets        | web UI page numbers | feeds, real-time | large datasets, simple ordering |

A fifth variant, time-based pagination (`?since=...&until=...`), specializes keyset for time-series and event data.

Checks that apply regardless of strategy:

- [ ] Every collection endpoint is paginated. An unbounded list response is a standing finding - "we don't need pagination for now" fails the moment any collection exceeds ~100 items.
- [ ] A default page size is set (commonly 20-50) and a maximum is enforced (commonly 100-1000); requesting past the maximum returns 400, never a silently clamped value.
- [ ] A `has_more` flag (or equivalent) exists, so clients never infer completion from a short page.
- [ ] Navigation links (`first`/`prev`/`next`/`last`, or an RFC 5988 `Link` header) are present - or their absence is a deliberate, documented choice for cursor-only APIs.
- [ ] One pagination pattern across the whole surface - offset on one resource and cursor on another is a consistency finding.
- [ ] Filters apply before the page is computed: filter → count → paginate → return.
- [ ] Edge cases have a specified shape: empty results (`data: []`, `has_more: false`), last page (`next: null`), out-of-range request (200 with an empty array, or a documented 404 - either, but specified).
- [ ] Sorting works alongside pagination; for cursor pagination the sort is encoded into the cursor, so a cursor minted under one sort can't be replayed against another.
- [ ] Total count, when present, is a deliberate cost decision - a `COUNT` degrades on large or fast-changing datasets; ask whether it's needed or should be opt-in (`?include_total=true`).

## 6. Filtering, sorting, field selection

Conventions to check against:

- Filtering: plain query parameters per filterable field, combinable - `GET /users?status=active&role=admin`, range filters as `price_min`/`price_max` or `createdAfter`.
- Sorting: a `sort` parameter; leading `-` (or a paired `order=desc`) for descending; comma-separated fields for multi-field sort - `?sort=-created_at`, `?sort=last_name,first_name`.
- Sparse fieldsets: `?fields=id,name,email` to request only named fields.
- Search: a `q` or `search` parameter for full-text search, kept distinct from structured `field=value` filters.

Checks:

- [ ] The same filter, sort, and search parameter names and casing appear on every collection endpoint.
- [ ] Filtering composes with pagination - filters apply before the page is computed, never after.
- [ ] A filter on an unknown field, or an invalid sort field, returns 400/422 - never silently ignored, which makes typos indistinguishable from empty results.
- [ ] Full-text search and structured filters are separate parameters, not overloaded onto one.

## 7. Error shape consistency

Shape only - the code taxonomy, message writing, retry signaling, and per-code documentation inside the envelope belong to `samber/developer-platform-skills@api-error-design`; do not duplicate that depth in a review.

- [ ] One error envelope on every endpoint and every status - the literal rule is "don't mix patterns". Some endpoints throwing, others returning `null`, others returning `{ error }` means the consumer can't predict behavior; it is the top review-level error finding.
- [ ] If a standard envelope is claimed, it is RFC 9457 problem details (`application/problem+json`; RFC 9457 obsoletes RFC 7807 - name 9457) and actually used on every error.
- [ ] The status code is correct independently of the body (dimension 3's checks apply to error responses too).
- [ ] No 500 body leaks a stack trace, database error text, internal path, or config - a security finding, not just a DX one.
- [ ] Validation happens at the surface's boundaries (request handlers, third-party responses), and error responses reflect it consistently.

## 8. Backward compatibility

Hyrum's Law, named as the framework: "With a sufficient number of users of an API, all observable behaviors of your system will be depended on by somebody, regardless of what you promise in the contract."

- [ ] The team is intentional about what is observable - every exposed field, code, ordering, and message is a potential commitment.
- [ ] Responses leak no implementation details a client could silently start depending on.
- [ ] The change under review prefers addition over modification: adding optional fields is safe; changing a field's type, removing a field, or making a new field required are breaking and need the versioning machinery (`samber/developer-platform-skills@api-versioning-policy`).
- [ ] The design extends one live contract instead of forking parallel versions - the one-version rule; ask "does this need a new version at all, or can it be added compatibly?" before reaching for a version bump.
- [ ] The contract is defined spec-first - the schema is the documentation, not a description written after the fact.
- [ ] Deprecation is planned at design time, not deferred to "later".

Rationalizations to reject, verbatim pushback for the review:

| Rationalization                            | Reality                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| "We'll document the API later"             | The schema is the documentation - write it first                                            |
| "We don't need pagination for now"         | Needed the moment any collection exceeds ~100 items                                         |
| "PATCH is complicated, let's just use PUT" | PUT demands the full object every time; clients want PATCH                                  |
| "Nobody uses that undocumented behavior"   | Hyrum's Law - if it's observable, someone depends on it                                     |
| "We can just maintain two versions"        | Multiplies maintenance cost, creates diamond dependencies                                   |
| "Internal APIs don't need contracts"       | Internal consumers are still consumers                                                      |
| "It's documented" (for a footgun)          | Developers don't read docs under deadline pressure - make the consistent choice the default |

## Sibling-boundary checks - one line each in the report

Check existence and uniform application only; the named sibling owns the depth.

- [ ] A versioning scheme exists and is applied consistently across the surface → `samber/developer-platform-skills@api-versioning-policy`.
- [ ] Unsafe-to-retry operations accept an idempotency key, or their retry-unsafety is documented → `samber/developer-platform-skills@api-idempotency-retry`.
- [ ] One auth model covers the surface, consistently applied → `samber/developer-platform-skills@api-auth-key-management`.
- [ ] Rate limits are signaled in responses (429 + headers) → `samber/developer-platform-skills@api-rate-limit-policy`.
- [ ] Every endpoint, parameter, and response is documented → `samber/developer-platform-skills@api-reference-quality`.

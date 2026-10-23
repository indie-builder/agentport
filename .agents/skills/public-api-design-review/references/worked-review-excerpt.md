# Worked review-report excerpt

An excerpt from a review of a fictional but representative surface - an orders/customers REST API heading for public beta. Every finding below is a documented real-world pattern (verb-in-URI, 200-with-error, mixed casing, unpaginated collections, silently ignored filters); the API itself is invented so the excerpt fits one page. Match this shape, not this content.

---

## Scope

- Surface: `api.example.com/v1` - 14 endpoints over `customers`, `orders`, `invoices`. OpenAPI 3.1 spec provided; 8 sampled production responses.
- Audience × stage: public × beta → blocking review; Must-change findings block launch.
- Rule corpus: none adopted by the team → findings cite this skill's checklist items by dimension and name.

## Dimension summary

| Dimension                              | Result                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1. Resource modeling & URI naming      | FAIL - 2 findings                                                                              |
| 2. HTTP method semantics               | pass                                                                                           |
| 3. Status-code correctness             | FAIL - 1 finding                                                                               |
| 4. Field-naming consistency            | FAIL - 1 finding                                                                               |
| 5. Pagination                          | FAIL - 2 findings                                                                              |
| 6. Filtering, sorting, field selection | FAIL - 1 finding                                                                               |
| 7. Error shape consistency             | pass (envelope uniform; depth deferred to `samber/developer-platform-skills@api-error-design`) |
| 8. Backward compatibility              | pass with 1 accepted deviation (below)                                                         |
| Sibling-boundary checks                | versioning ✓, idempotency ✓, auth ✓, rate limits ✓, docs gap → 1 Improvement                   |

## Findings

| #   | Finding                                                                                  | Dimension | Bucket      | Cited rule                                                              | Fix                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------- | --------- | ----------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `POST /orders/{id}/cancel-order` - verb in the URI                                       | 1         | Must-change | "Resources are nouns, never verbs"                                      | `POST /orders/{id}/cancel` as the surface's one custom-method convention, applied to the two other action endpoints too                                                                    |
| 2   | `/customers/{id}/orders/{id}/invoices/{id}/lines` - 4-level nesting                      | 1         | Must-change | "Nesting stops at 2-3 levels"                                           | Promote `invoices` to a top-level resource filtered by `order_id`                                                                                                                          |
| 3   | `DELETE /customers/{id}` returns 200 with `{"success": false, "error": ...}` on conflict | 3         | Must-change | "No 200 carrying an error object"                                       | Return 409 with the surface's standard error envelope                                                                                                                                      |
| 4   | `orders` returns `created_at`; `customers` returns `createdAt`                           | 4         | Must-change | "One casing convention... consistency of the choice is the check"       | Standardize on `created_at` (majority of the surface); alias-and-deprecate `createdAt` via `samber/developer-platform-skills@api-versioning-policy` machinery - clients already observe it |
| 5   | `GET /invoices` is unpaginated                                                           | 5         | Must-change | "Every collection endpoint is paginated"                                | Cursor pagination, matching the other two collections                                                                                                                                      |
| 6   | No `has_more` equivalent on any collection                                               | 5         | Improvement | no corpus rule adopted; checklist SHOULD-level item                     | Add `has_more`; cheap now, breaking to retrofit later                                                                                                                                      |
| 7   | `GET /orders?staus=open` returns the full unfiltered list                                | 6         | Must-change | "A filter on an unknown field returns 400/422 - never silently ignored" | 400 with the unknown parameter named                                                                                                                                                       |
| 8   | Two endpoints undocumented in the reference                                              | boundary  | Improvement | one-line docs check                                                     | Hand to `samber/developer-platform-skills@api-reference-quality`                                                                                                                           |

## Accepted deviations

- **Offset pagination retained on `GET /customers`** despite the surface standardizing on cursors. Rationale recorded by the team: the admin UI needs numbered pages and random access; dataset is small and slow-changing, where offset's weaknesses don't bite (strategy table, dimension 5). Deviation documented here - binding as precedent for future admin-facing collections, not a silent inconsistency.

## Ship gate

Findings 1-5 and 7 (Must-change) open → beta launch blocked. Findings 6 and 8 (Improvement) may ship open. Finding 4's fix is itself a breaking change: schedule through `samber/developer-platform-skills@api-versioning-policy`, don't hot-swap the field.

---

## Negative example - the comment this format exists to prevent

> **BLOCKING:** I'd go with camelCase here, snake_case always looks dated to me. Also consider nesting invoices under orders, it reads better.

Everything wrong at once:

- It blocks on taste with no cited rule ("looks dated to me").
- It pushes casing preference where the only citable rule is consistency of the choice.
- "Consider..." is advisory phrasing inside a blocking comment.
- It re-litigates a structure the team may have settled in a prior review.

Written correctly, the casing point is finding 4 (cite the consistency rule, either casing acceptable), and the nesting point is either a cited-rule finding (if depth exceeds 3) or an Improvement - never a block.

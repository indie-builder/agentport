# Surface condition tables

Decision aids for step 4 of the workflow. The tables encode sourced patterns. Where a table is synthesis across sources rather than one cited framework, it says so - keep that label when copying rows into a plan.

## Per-surface reversal-cost tiers

Reversal cost is what a wrong commitment costs to unwind once unknown third parties depend on the surface (Hyrum's Law). This table is an inferred synthesis across breaking-change literature, not one cited source - reasonable practitioners may order the middle tiers differently.

| Surface                  | Reversal cost                    | Why                                                                                     |
| ------------------------ | -------------------------------- | --------------------------------------------------------------------------------------- |
| Webhooks                 | Low-medium                       | Event types extend additively; consumers tolerate new fields                            |
| REST                     | Low (additive) / High (breaking) | Endpoints and optional params extend safely; removals and renames break unknown clients |
| Bulk / warehouse shares  | Medium                           | Schema changes ripple into customer SQL and BI dashboards                               |
| MCP tool definitions     | Medium (today)                   | Derived and regenerable from the spec, but agent workflows depend on stable tool names  |
| Embedded UI / components | Medium                           | Versioned components, but a visual and behavioral contract partners build around        |
| GraphQL schema           | High                             | A tight public contract; deprecations are visible but binding                           |
| Server SDKs              | High                             | Method signatures baked directly into customer code                                     |

The practical consequence: commit early to the low-tier surfaces, and delay every high-tier commitment until the contract it projects has stabilized. This is also why mature platforms generate REST docs, SDKs, and MCP from one OpenAPI source of truth (Stripe, Twilio, Cloudflare) - one change propagates everywhere instead of needing a separate migration per surface.

## Buyer type: API-first vs embedded-first

Use as a quick decision aid, not a strict rule. Map interview answer 1 here before ranking postures.

| Condition          | API-first wins                                | Embedded-first wins                          |
| ------------------ | --------------------------------------------- | -------------------------------------------- |
| Buyer type         | Technical - a developer chooses the tool      | Non-technical business buyer                 |
| Time-to-value need | Days acceptable                               | Hours required                               |
| Product complexity | Customer wants full control and customization | Customer wants turnkey, compliance handled   |
| Market maturity    | Mature; developers expect programmable access | Nascent; buyer needs guardrails              |
| Distribution       | Developer word-of-mouth, bottom-up            | Sales-led, embedded into a partner's product |

Two caveats that keep this table honest:

- **Layer, don't choose.** The 2025-2026 trend is API-first as the architectural foundation with an embedded/unified layer added later to accelerate go-to-market - not one paradigm excluding the other. Stripe won developers API-first, then layered drop-in embedded flows for non-developers. Retention argument for keeping the API foundation: an API embedded in customer production code has a switching cost measured in engineering hours, not a cancellation click.
- **Depth check before claiming API-first.** Retrofitting APIs onto a UI-first product typically exposes only a fraction of real functionality - a documented lending-industry critique describes partners discovering mid-integration that intake is API-accessible but underwriting still needs a manual step. Probe depth per capability in step 2.

## Demand-signal weighting

- **Pipeline/sales blockers - highest weight.** Low-frequency, high-severity: "a retention or sales risk - few hit it, but the ones who do churn or block deals." A named blocked deal outranks any volume metric.
- **Usage telemetry by client type - strongest volume signal.** Twilio's canonical instance: "At Twilio, 77% of all requests to our REST API are made by a helper library user-agent" - the data that justified formalizing, then auto-generating, its SDKs.
- **Community/engagement signals - third.** Stars, asks, forum chatter: real but cheap to emit. Confirm against the two signals above before scheduling a surface on them alone.
- **Standard prioritization frameworks (RICE, ICE, impact-effort) sit on top of these signals** - they rank what the signals surface. They never replace gathering them.

## GraphQL and gRPC promotion conditions

- **GraphQL**: promote only on a named, integrator-confirmed pain - client-driven data access, mobile over/under-fetching, the N+1 problem - never as a default REST replacement. Budget roughly 20-40% overhead on the initial build plus N+1 and authorization complexity. Paradigm switches are two-year-horizon decisions. Shopify is the counter-example to cite in both directions: it went GraphQL-first for its Admin API (REST marked legacy October 2024, GraphQL required for new apps by April 2025) and drew significant developer pushback over verbosity.
- **gRPC**: a niche public surface - promote when the audience is backend teams needing streaming or strict latency budgets, and the platform can support the proto toolchain integrators need. Otherwise leave it internal. The sibling gRPC skill owns the design if promoted.

## MCP: scheduling, build-vs-buy, monetization

- **Scheduling**: MCP is a thin layer derived from an existing REST or GraphQL surface, added once that foundation is stable and step-3 agent signals justify it. Adoption is real and fast (multi-vendor governance under the Linux Foundation since December 2025, with RFPs starting to require "MCP-compatible"), which is exactly why the demand signal - not the hype - sets the date.
- **Build vs buy**: a demo-grade server is a weekend. A production-grade hand-build runs from roughly 150-250 hours for a narrow internal tool to several months for a public, multi-tenant, or heavily-permissioned one, plus an estimated $50K-150K/year to maintain (independently corroborated across multiple 2026 cost guides for the enterprise-maintenance tier, though the same guides disagree with each other by more than an order of magnitude on total build cost - $25K-$120K in one, $300K-$700K+ in another, for what each calls a comparable production build). Managed platforms absorb the infrastructure and protocol churn. The economics tilt toward managed at roughly 3-5 enterprise integrations. Build in-house only when AI access to a system nobody else owns (vertical SaaS, proprietary dataset, regulated workflow) is itself the paid product. Every figure in this bullet is a vendor- or analyst-reported estimate, not measured data - carry the ratio (a weekend demo against months of production work) into the plan, never the number.
- **Security caveat to carry into the plan**: only about 8.5% of servers implement MCP's mandatory OAuth 2.1 requirement in practice - re-verified as still current, and corroborated across multiple independent March 2026 audits (NimbleBrain's direct query of the official MCP registry across 3,012 unique servers, Practical DevSecOps, Cybertizeweb, Affinco), not a single vendor's self-reported figure. Unauthorized internal servers ("MCP Shadow IT") are a named enterprise risk, an argument for the managed rung and for treating the MCP surface as a real product, not a hackathon artifact.
- **Monetization**: per-call agent payments are unproven. Typical per-call values are "barely worth metering". The x402 protocol's observed volumes peaked near $800K-$1M/day in Q4 2025 (largely developer testing, per Chainalysis), then collapsed - a March 2026 CoinDesk snapshot found roughly $28K/day with about half attributed to wash trading, and by mid-2026 the 7-day average sat near $41K-$42K/day, down roughly 93% year-to-date from the December 2025 peak. Stripe's Machine Payments Protocol (announced March 2026) remains early-stage with no comparable volume data published. Re-check both before citing; this is a moving, still-declining baseline, not a stable snapshot. Defer per-call MCP monetization until call values clear metering overhead. Label any such revenue line speculative.

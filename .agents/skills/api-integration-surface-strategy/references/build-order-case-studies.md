# Build-order case studies

Documented surface-rollout timelines behind the default sequence in step 4. The non-fintech cases lead: two structurally different domains (data infrastructure, telephony) converging on the same order is the strongest evidence the sequence is a property of reversal cost and audience economics, not an artifact of payments regulation.

## Segment (martech / data infrastructure)

1. **~2012 - tracking API + SDK**: `analytics.js`, an open-source tracking library plus a hosted tracking API, was the founding product.
2. **Sources & Destinations routing**, built directly on the tracking API.
3. **2015 (rolling into 2016) - Warehouses**: SQL/warehouse loading into Redshift/Postgres - the bulk surface, added once customers were already exporting event data manually.
4. **December 12, 2018 - Config API**: a REST management API launched with an explicit no-breaking-changes commitment from day one.
5. **~2021 - Public API**: REST successor to the Config API (exact GA date not exposed publicly - uncertain); Config API tokens stopped being issued February 2024.
6. **2022 - Reverse ETL**, extended via Unify in 2023.
7. **2025+ - AI-agent surface**: delivered via parent company Twilio's MCP server indexing Segment's docs, not a standalone first-party server.

Order: tracking API/SDK → routing → warehouse/SQL (bulk) → REST management API → reverse ETL → MCP (derived, via parent).

## Twilio (communications)

1. **November 2008 - Voice API**: the founding product.
2. **February 2010 - SMS API** - the REST API has stayed pinned to base version `2010-04-01` ever since - a live example of how binding a public REST contract becomes.
3. **Helper libraries / SDKs** on top of REST, migrated (~2016-17) to homegrown OpenAPI auto-generation once hand-maintaining idiomatic libraries stopped scaling - reaching 200+ endpoints across 7 languages. The trigger was telemetry: 77% of REST requests already carried a helper-library user-agent. The rollout was capacity-matched: languages were added only once tooling let Twilio "support them sustainably."
4. **March 2025 - Twilio Alpha MCP server** (developer preview) indexing 1,400+ endpoints from Twilio's own public OpenAPI specs. A later Public Beta covers 1,800+ endpoints plus SendGrid and Segment documentation.

Order: REST → REST (second product) → SDKs (hand-built, then generated) → MCP (derived).

## Stripe (fintech)

REST + embedded UI early (Stripe.js/Elements/Checkout - the API-first foundation plus the embedded layer for non-developers) → webhooks/Events API → SDKs (auto-generated across languages, with monthly API versioning and breaking changes only twice a year) → MCP server / Agent Toolkit (February 2025, built on the existing Python and Node SDKs, hosted at `mcp.stripe.com`). Stripe has no public GraphQL API - it stayed REST throughout.

Stripe's webhook-migration pattern is worth copying when any surface changes version:

1. Create a new endpoint pinned to the target version.
2. Migrate traffic.
3. Decommission the old one only once confident.

Never mutate the live endpoint in place.

## Plaid (fintech)

REST + Plaid Link (the embedded client-side onboarding component, central from early on) → webhooks → server SDKs, then client SDKs (iOS/React Native) later → a 2025 CLI explicitly designed for dual audiences: readable table output for developers, JSON with clean stdout/stderr separation for AI agents. Plaid is the named model for the CLI surface serving humans and agents at once.

## The MCP launch wave (dated evidence for "derive, don't hand-build")

- **February 20, 2025** - Stripe ships its MCP server / Agent Toolkit, built directly on its existing SDKs.
- **May 2025** - Cloudflare's MCP Demo Day: Asana, Atlassian, Block, Intercom, Linear, PayPal, Sentry, Stripe, and Webflow all launch remote MCP servers on Cloudflare's infrastructure in one coordinated event.
- **February 2026** - Atlassian's remote MCP server reaches GA.
- **May 6, 2026** - AWS's MCP Server reaches general availability (preview from November 2025), with a single `call_aws` tool executing 15,000+ AWS API operations using the caller's existing IAM credentials.

Every named platform generated its MCP surface from an already-existing API rather than building agent access as a separate product - the pattern the step-4 rule ("MCP-first is not on the menu") rests on.

## What transfers

- REST (or an event/tracking API) plus webhooks first → the embedded layer where the buyer needs it → SDKs once the contract stabilizes → bulk/warehouse when BI demand shows → MCP last and derived. Fintech and non-fintech independently converged on this shape.
- The one deviation pattern is audience-driven, not novelty-driven: Segment added its bulk/SQL surface mid-sequence because its BI consumers demanded it - the audience map, not the protocol fashion of the year, reordered the middle.

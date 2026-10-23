# Review-program benchmarks - triggers, authority, scaling

Verified models from the five best-documented API design-review programs, for step 6 of the review workflow. Cite these companies and patterns by name; generalize cautiously, since each represents one organization's solution, not a universal standard.

## Triggers and cadence, by organization

Cadence is audience- and lifecycle-triggered in all five programs below, and in every other named API-specific program checked (Adidas API Guidelines, Atlassian's automated conformance checks, Kubernetes SIG Architecture's `api-review`-label queue, PayPal's per-pull-request review) - none of them reviews on a fixed calendar. The one documented exception is a separate Microsoft program: the .NET API Review process (BCL/runtime FXDC, and the ASP.NET Core API Review group) holds its review meeting on a fixed weekly calendar slot, published at apireview.net/schedule and streamed to the .NET Foundation YouTube channel, regardless of whether a given API is ready that week. Entry into the queue is still change-triggered (an issue must carry the `api-ready-for-review` label), but the meeting itself runs on a standing weekly slot rather than being scheduled per proposal - a genuine calendar trigger at the meeting level, layered on top of a change-triggered queue. This is a different Microsoft program from the Azure Stewardship Board below. Separately, generic enterprise/architecture review boards (TOGAF-style, not API-specific) commonly do run on monthly or quarterly calendars - a broader IT-governance layer distinct from the API-specific programs cataloged here.

- **Google** (AIP-100): review keyed on audience (internal / partners / anyone) × release level (alpha/beta/GA).
  - Required at beta and at GA-if-changed.
  - Recommended at alpha.
  - Not required for internal or single-customer APIs.
  - Alpha may launch without approval if usage is limited to a known user set.
  - Beta launches block on unresolved issues.
  - Turnaround explicitly scoped: incremental changes take days, a small new API about a week, a large surface a month or more.
- **Microsoft Azure**: teams engage the Stewardship Board "early in the development process".
  - MUST and SHOULD-NOT deviations must be disclosed during review.
- **Stripe**: every API-modifying change goes through review.
  - External-facing changes additionally get a lightweight mailing-list review: Stripe's own engineering blog ("APIs as infrastructure: future-proofing Stripe with versioning") confirms this directly - "outgoing changes are funneled through a lightweight API review process where they're written up in a brief supporting document and submitted to a mailing list." The review-board composition, "gavel blocks", and ~20-page design-doc detail below remain sourced to Kenneth Auchenberg's account, not this Stripe primary source.
- **Zalando**: review triggers for every API tagged `x-api-audience != component-internal` - audience-tagging built into the spec itself.

## Authority and composition, by organization

| Org             | Review body                                                                                                      | Authority                                                                                                                 | Distinctive move                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Google          | Distributed pool of certified "API readability" holders + AIP editors                                            | Blocking at beta/GA; bypass requires an explicit director-or-VP decision (AIP-1)                                          | Reviewer certification, modeled on Google's code-readability program, to grow scarce reviewer supply |
| Microsoft Azure | HTTP/REST Stewardship Board + SDK Architecture Board (≥3 architects from different language groups must approve) | Blocking; exceptions require contacting the board before implementation                                                   | Tier-1 languages reviewed together for cross-language consistency                                    |
| Stripe          | Cross-functional "API Review" team - "engineers who care about API design"                                       | Blocking ("forcing function"); "gavel blocks" as stakeholder checkboxes in the design doc; disputes resolved async in-doc | Documents rejected design alternatives directly in the ~20-page design doc                           |
| Zalando         | API Guild + two named mandatory reviewers, Zally linter as first pass                                            | Lightweight; findings tracked in GitHub as Must-change vs Improvement                                                     | Open-sourced its linter (Zally); architects auto-notified by the CTO office                          |
| PayPal          | Central API Design team (PPaaS)                                                                                  | Consultative, not blocking - Jayadeba Jena's four-step governance process                                                 | Public style guide with JSON-Schema field definitions                                                |

Recurring cross-functional stakeholders:

- Security review - Microsoft pairs it with board engagement.
- Documentation writers - Erik Wilde flags their absence as a common composition gap.
- Stripe's stakeholder checkboxes in the doc itself.

## The precedent mechanism (Google AIP-100), verbatim anchors

The published answer to "must-fix or reviewer taste":

- Precedent defined: "decisions that have already been made by previous APIs, which generally should be binding upon newer APIs in similar situations" - covering naming, standard fields, pagination, long-running operations.
- Deviation burden: a rationale comment "must be prefixed with `aip.dev/not-precedent`", with the rationale drawn from documented exception reasons - the reviewer cannot block on taste, and the deviator cannot deviate without a trace.
- Deference: "Reviewers want to avoid causing you churn, and therefore usually give deference to previous reviews... reference the code review where the issue was decided." Reopen only for a significant, still-consequential mistake.
- Escalation: strong disagreement escalates per AIP-1; outright bypass requires "a director or VP [to] make an explicit choice to put these other concerns ahead of product excellence."
- AIP-200 names the enumerated deviation reasons a rationale must match: local consistency (breaking an API's own existing pattern is jarring even if the pattern itself deviates from the wider standard), pre-existing functionality (a violation shipped before AIP guidance existed and can't be easily changed), adherence to an external spec, adherence to an existing system ("meet the customer where they are"), expediency (a deadline that can't accommodate the better design), and technical concerns (internal-systems cases where compliance costs more than it's worth).

Note: AIP-100 enforces the must-fix/taste boundary structurally through the mechanism itself, not through exhortation. The precedent mechanism is what allows disagreement to resolve without reviewer taste blocking progress.

Erik Wilde arrives at the same test from the other direction - "I am not a big fan of just reusing existing rule sets" - a rule only earns must-fix status once the organization can articulate its own intent for it. Fork a public corpus to start. Adapt it before enforcing it.

## The scaling trajectory: centralized → federated → automated

All five programs scaled the same way: mechanical checks pushed into a linter, then a distributed pool of trained reviewers, then domain-embedded reviewers feeding a central standards team. Nobody scaled by growing a central committee.

- Linting substrate:
  - Google's API Linter (in-editor, as-you-type).
  - Zalando's Zally.
  - The OpenAPI-ecosystem standards Spectral, Vacuum, and Redocly CLI.
  - Adidas ships its own Spectral ruleset so any team lints locally.

  Wilde's limitation applies to all: linters "check for structural conditions... they cannot tell you whether the description is written in a way that helps [a consumer] understand what the operation is for" - linting owns mechanical must-fixes, humans keep semantics.

- Federated authority: Shopify/GitHub's GraphQL practice has product teams (domain experts) design the schema while a central API team supports rather than blocks - "think domain >>> data" (Marc-André Giroux), with schema-diff tooling carrying consistency.
- The enterprise-named version is the API Center of Excellence: a central team sets standards, embedded "coaches" apply them per domain and feed issues back. Corroborated across vendor and practitioner sources. Nordic APIs (Bill Doerrfeld) publishes named case studies, e.g. Atlassian's.

## Staged launch playbook (program from scratch)

1. Write an RFC-2119-keyworded (MUST/SHOULD/MAY) rule corpus - fork Zalando or Adidas (most reusable) or Microsoft (most enterprise-complete) rather than starting blank. Adapt before enforcing (Wilde's warning).
2. Wire a linter (Spectral for OpenAPI; Zally runs Zalando's ruleset out of the box) into CI and the editor, so humans never spend review time on mechanical checks.
3. Trigger review by audience × lifecycle - required at beta/GA for externally consumable APIs, recommended at alpha, skipped for internal-only.
4. Publish the escalation path and named override authority up front, so disagreements resolve in days.
5. Require every blocking objection to cite a written rule or precedent, and every deviation to record a rationale.
6. When the central team becomes the friction point, federate and educate - never grow the committee.

## Program-health metrics and course corrections

- Rising turnaround, or teams shipping without review → too heavy: automate more, delegate more, federate.
- Defects reaching GA that a written rule would have caught → too light / rubber-stamping: add the rule to the linter, enforce citation.
- Reviewer guidance diverging between teams → codify the disputed decision as precedent in the versioned corpus.
- Benchmarks: under-a-week turnaround for small APIs. A median past ~2 weeks signals a bottleneck. Google's post-reform survey: about 60% of participants content with review pace, and of the ~80% who used the linter, they reported it made their API design more iterative - cite both as Google-specific measurements, not industry norms.

## Named failure evidence, for citation

- **Bottlenecking - Stripe's own admission.** Kenneth Auchenberg (built Stripe's developer platform): API Review "was challenging to manage as a centralized friction point for the company, particularly at scale with 1000s of engineers. If I were to do things differently today, I would probably pivot the concept away from 'review' to more of an education service." The strongest citable argument for federation.
- **Reviews starting too late.** Google's ICSE 2024 paper ("API Governance at Scale", DOI 10.1145/3639477.3639713): pre-reform, "reviews often began too late... the review process forced teams to start over when they thought they had done a good job."
- **Pool growth degrading consistency.** Same paper: "as the number of participants grew, so did the turnaround time... and the inconsistency in reviewer guidance, due to constantly evolving style guides and best practices."
- **Origin story.** Macvean, Maly & Daughtry, "API Design Reviews at Scale" (CHI 2016, DOI 10.1145/2851581.2851602): Google's users suffered "a death from a thousand papercuts", answered with "a lightweight, scalable, distributed design review process".
- **Why it's product excellence, not bureaucracy.** A study cited in Google's 2024 governance paper (Nadi et al.): 88% of Google Play apps using cryptographic APIs contain at least one API-misuse mistake - the standard citation for badly designed APIs causing measurable defects.

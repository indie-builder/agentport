# Taxonomy catalog examples

Worked excerpts of the three taxonomy shapes, the validation-detail structures, and the two named production case studies. Values are illustrative; the shapes are what to copy.

## Table of Contents

- [Flat code catalog](#flat-code-catalog)
- [Code/subcode catalog (default rung)](#codesubcode-catalog-default-rung)
- [Domain/reason (Google AIP-193 `ErrorInfo`)](#domainreason-google-aip-193-errorinfo)
- [Field-level validation detail](#field-level-validation-detail)
- [Cross-field validation detail](#cross-field-validation-detail)
- [Case study: Stripe's layered error object](#case-study-stripes-layered-error-object)
- [Case study: Google `google.rpc.Status` + `ErrorInfo`](#case-study-google-googlerpcstatus-errorinfo)

## Flat code catalog

One code per error condition, each pinned to one HTTP status. Complete for a small surface where each category has essentially one reason.

```json
{
  "INVALID_REQUEST": { "status": 400 },
  "UNAUTHENTICATED": { "status": 401 },
  "FORBIDDEN": { "status": 403 },
  "NOT_FOUND": { "status": 404 },
  "CONFLICT": { "status": 409 },
  "RATE_LIMITED": { "status": 429 },
  "INTERNAL_ERROR": { "status": 500 }
}
```

## Code/subcode catalog (default rung)

A top-level `code` per category, each pinned to one HTTP status, with a `subcodes` map for the specific reasons under it:

```json
{
  "VALIDATION_ERROR": {
    "status": 400,
    "subcodes": {
      "REQUIRED": "...",
      "INVALID_FORMAT": "...",
      "OUT_OF_RANGE": "...",
      "INVALID_ENUM": "..."
    }
  },
  "AUTHENTICATION_ERROR": {
    "status": 401,
    "subcodes": {
      "MISSING_TOKEN": "...",
      "INVALID_TOKEN": "...",
      "EXPIRED_TOKEN": "..."
    }
  },
  "AUTHORIZATION_ERROR": {
    "status": 403,
    "subcodes": {
      "INSUFFICIENT_PERMISSIONS": "...",
      "RESOURCE_FORBIDDEN": "..."
    }
  },
  "CONFLICT_ERROR": {
    "status": 409,
    "subcodes": {
      "RESOURCE_ALREADY_EXISTS": "...",
      "CONCURRENT_MODIFICATION": "..."
    }
  }
}
```

Publish this catalog as a single reference document - or generate it from the OpenAPI spec - so every code a client can ever see is enumerable ahead of time.

## Domain/reason (Google AIP-193 `ErrorInfo`)

The error's stable machine-readable identity is the `(domain, reason)` pair, decoupled from HTTP status entirely - useful when one taxonomy must span REST and gRPC, or several services. `metadata` carries dynamic context.

```json
{
  "error_info": {
    "domain": "billing.api.example.com",
    "reason": "QUOTA_EXCEEDED",
    "metadata": {
      "quota_limit": "1000",
      "quota_period": "daily",
      "service": "invoices"
    }
  }
}
```

The stability contract: `domain` and `reason` stay consistent over time, and metadata keys for a given pair can only be added, never removed.

## Field-level validation detail

Attach per-field detail so one API error maps to multiple form-field indicators in one round trip:

```json
{
  "code": "VALIDATION_ERROR",
  "errors": [
    {
      "field": "age",
      "code": "OUT_OF_RANGE",
      "message": "age must be between 18 and 120; received 15.",
      "value_provided": 15,
      "constraints": { "min": 18, "max": 120 }
    }
  ]
}
```

## Cross-field validation detail

A constraint spanning fields (e.g. `end_date` before `start_date`) uses a `fields` array and a `values_provided` map - never force it into the single-field shape:

```json
{
  "code": "VALIDATION_ERROR",
  "errors": [
    {
      "fields": ["start_date", "end_date"],
      "code": "INVALID_RANGE",
      "message": "end_date must be after start_date.",
      "values_provided": {
        "start_date": "2026-09-10",
        "end_date": "2026-09-01"
      }
    }
  ]
}
```

## Case study: Stripe's layered error object

Four layers of specificity in one response, each populated only when it adds information beyond the layer above:

- `type` - broad category: `api_error`, `card_error`, `idempotency_error`, `invalid_request_error`.
- `code` - short, stable, programmatically-handleable string for errors worth branching on.
- `decline_code` - only on card errors declined by the issuer; a narrower code from the card network, not Stripe.
- `param` - names the exact request field at fault, so callers highlight the right form field without parsing `message`.
- `message` - human-readable; for card errors, written to be safe to show directly to end users.
- `doc_url` - links to that exact code's entry in Stripe's public error-code table; every code is documented there before it ships.

Under `decline_code`, Stripe layers a third level (the Charge `outcome`: network decline code, advice code, risk level, seller message) - "one error code" is a false economy in domains with genuinely multi-layered failure causes. Cite Stripe as the reference for a REST-only API where per-code documentation is a differentiator.

## Case study: Google `google.rpc.Status` + `ErrorInfo`

The gRPC-native model, also used across Google Cloud REST APIs:

- `code` - an enum value from the small closed `google.rpc.Code` set.
- `message` - developer-facing English, explicitly not contractually stable; client code must never parse it.
- `details[]` - typed messages, canonically one `ErrorInfo` per error carrying the stable `domain` + `reason` identity.
- Localization: `message` stays stable; a separate `LocalizedMessage` detail carries translated end-user text.

Cite AIP-193 as the reference for an API family spanning REST and gRPC, or one needing a stable identity decoupled from HTTP status.

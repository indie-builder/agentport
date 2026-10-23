# Message rewrite examples

Good/bad pairs for the human-readable half of an error. A good message is human-readable, actionable, and consistent in format with every other error the API returns - three independent properties; check each separately. Except for the Zoho Creator complaint below, which is quoted verbatim from a real support thread, every payload here is written for this file and its values are illustrative.

## Table of Contents

- [The canonical negative example (real support complaint)](#the-canonical-negative-example-real-support-complaint)
- [Readable but not actionable](#readable-but-not-actionable)
- [Actionable but not readable](#actionable-but-not-readable)
- [Blaming vs corrective tone (NN/g)](#blaming-vs-corrective-tone-nng)
- [When prose can't carry the fix](#when-prose-cant-carry-the-fix)
- [Localization](#localization)

## The canonical negative example (real support complaint)

A Zoho Creator API user's actual complaint - a rule named with no field, no expected value, no received value, no self-serve path:

```json
{ "code": 2945, "description": "LESS_THAN_MIN_OCCURANCE" }
```

Rewrite - name the field, the value received, and the constraint violated in the same object:

```json
{
  "code": "VALIDATION_ERROR",
  "errors": [
    {
      "field": "line_items",
      "code": "TOO_FEW_ITEMS",
      "message": "line_items must contain at least 1 item; received 0.",
      "value_provided": 0,
      "constraints": { "min_items": 1 }
    }
  ]
}
```

## Readable but not actionable

Bad - nothing to act on:

```json
{ "code": "VALIDATION_ERROR", "message": "Request validation failed" }
```

Good:

```json
{
  "code": "VALIDATION_ERROR",
  "message": "currency must be a 3-letter ISO 4217 code; received 'euro'. Did you mean 'EUR'?"
}
```

## Actionable but not readable

Bad - a raw pattern with no explanation:

```json
{ "code": "INVALID_FORMAT", "message": "^[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}$" }
```

Good - explain the constraint, keep the pattern as supporting detail:

```json
{
  "code": "INVALID_FORMAT",
  "message": "account_iban must be a valid IBAN: 2 letters, 2 digits, then up to 30 alphanumeric characters.",
  "constraints": { "pattern": "^[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}$" }
}
```

## Blaming vs corrective tone (NN/g)

Swap accusatory phrasing for neutral, corrective phrasing:

- Bad: "You entered an invalid date."
- Good: "Provide the date as `MM/DD/YYYY`."

Match severity to the situation: a validation error the caller can fix and retry must not read like a system outage.

## When prose can't carry the fix

Some errors are far easier for a human to resolve outside code - a rule that takes a paragraph to justify. Don't cram the paragraph into `message`; link out:

```json
{
  "code": "TAX_JURISDICTION_MISMATCH",
  "message": "The shipping address resolves to a jurisdiction this account is not registered in.",
  "documentation_url": "https://docs.example.com/errors#TAX_JURISDICTION_MISMATCH"
}
```

## Localization

Translate the prose, never the identity:

```http
POST /v1/accounts
Accept-Language: fr
```

```http
HTTP/1.1 400 Bad Request
Content-Language: fr
Content-Type: application/problem+json

{
  "code": "VALIDATION_ERROR",
  "detail": "Le champ email doit être une adresse e-mail valide ; reçu « not-an-email ».",
  "request_id": "req_2b3c4d5e"
}
```

`code` stays present and untranslated - it is the field client code branches and reports on. Google's variant achieves the same split differently: `message` stays stable and developer-facing, and a separate localized-message detail carries the end-user text.

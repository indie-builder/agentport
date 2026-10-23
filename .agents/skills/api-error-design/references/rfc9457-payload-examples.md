# RFC 9457 payload examples

RFC 9457 (July 2023) obsoletes RFC 7807; the five core fields and the media type are unchanged, so a 7807 envelope is still the right shape - but design to, and cite, 9457. The revision dropped 7807's ambiguous multi-status proposal, added an IANA registry for common problem-type URIs, and formalized the extension-member guidance that the machine-readable taxonomy builds on.

Always send `Content-Type: application/problem+json`, and always pick the correct HTTP status first - the body explains the status, it never replaces it.

Every payload below is written for this file against the sourced shapes; the domains, code names, and IDs are illustrative, and the structures are what to copy.

## Table of Contents

- [Base envelope (standard fields only)](#base-envelope-standard-fields-only)
- [Full envelope with extension members](#full-envelope-with-extension-members)
- [Retryable error with retry object](#retryable-error-with-retry-object)
- [500 with an explicit retry signal](#500-with-an-explicit-retry-signal)
- [Negative example: 200 with an error body](#negative-example-200-with-an-error-body)
- [Negative example: leaked internals on 500](#negative-example-leaked-internals-on-500)

## Base envelope (standard fields only)

```http
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json

{
  "type": "https://api.example.com/errors/validation-error",
  "title": "Validation Error",
  "status": 422,
  "detail": "The 'email' field must be a valid email address.",
  "instance": "/users/req-abc123"
}
```

## Full envelope with extension members

Standard fields stay generic and human-readable; extension members carry the taxonomy, field detail, retry signal, doc link, and request ID:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json
X-Request-ID: req_9f8e7d6c

{
  "type": "https://api.example.com/errors/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Two fields failed validation.",
  "instance": "/v1/accounts",
  "code": "VALIDATION_ERROR",
  "errors": [
    {
      "field": "age",
      "code": "OUT_OF_RANGE",
      "message": "age must be between 18 and 120; received 15.",
      "value_provided": 15,
      "constraints": { "min": 18, "max": 120 }
    },
    {
      "field": "email",
      "code": "INVALID_FORMAT",
      "message": "email must be a valid email address; received 'not-an-email'."
    }
  ],
  "retryable": false,
  "documentation_url": "https://docs.example.com/errors#VALIDATION_ERROR",
  "request_id": "req_9f8e7d6c"
}
```

## Retryable error with retry object

`Retry-After` is the minimum signal on 429 and 503 (a real HTTP header generic clients parse). The body's retry object repeats and enriches it, because not every client library surfaces headers as easily as the parsed body:

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/problem+json
Retry-After: 60

{
  "type": "https://api.example.com/errors/service-unavailable",
  "title": "Service Unavailable",
  "status": 503,
  "detail": "The service is temporarily unavailable.",
  "code": "SERVICE_UNAVAILABLE",
  "retry": { "retryable": true, "retry_after": 60, "max_retries": 3, "backoff": "exponential" },
  "request_id": "req_1a2b3c4d"
}
```

## 500 with an explicit retry signal

500 is genuinely ambiguous - transient downstream blip or real bug. Emit the retry object explicitly instead of letting the caller guess; a bare 500 with no retry signal is the gap to close:

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/problem+json

{
  "type": "https://api.example.com/errors/internal",
  "title": "Internal Error",
  "status": 500,
  "detail": "An unexpected error occurred processing this request.",
  "code": "INTERNAL_ERROR",
  "retry": { "retryable": true, "retry_after": 5, "max_retries": 2, "backoff": "exponential" },
  "request_id": "req_5e6f7a8b"
}
```

## Negative example: 200 with an error body

The status code lies to every proxy, cache, monitor, and generic client that never reads the body. AIP-193 warns against exactly this partial-error pattern; it is acceptable only for bulk/long-running operations, and per-item failures must still reuse the standard error shape.

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "success": false, "error": "Payment could not be processed" }
```

## Negative example: leaked internals on 500

A security finding, not just a DX one - stack traces, database error text, internal paths, and config never belong in a response body:

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/json

{
  "error": "PDOException: SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry 'a@b.com' for key 'users.email_unique' in /var/www/app/src/Repository/UserRepository.php:112"
}
```

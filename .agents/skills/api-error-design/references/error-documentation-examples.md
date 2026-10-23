# Per-endpoint error documentation and request-ID wiring

The spec fragments and payloads below are written for this file; the paths, code names, and IDs are illustrative, and the structures are what to copy.

## OpenAPI: one named example per error code

Document every possible error per endpoint, not just the happy path. Each status an endpoint can return gets its own `responses` entry, with a named `examples` entry per distinct error code under that status - never one generic schema reference:

```yaml
paths:
  /v1/accounts:
    post:
      responses:
        "400":
          description: Validation failed
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
              examples:
                validation_error:
                  value:
                    code: VALIDATION_ERROR
                    detail: "email must be a valid email address; received 'not-an-email'."
        "401":
          description: Authentication failed
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
              examples:
                missing_token:
                  value:
                    {
                      code: MISSING_TOKEN,
                      detail: "No authentication token provided.",
                    }
                invalid_token:
                  value:
                    {
                      code: INVALID_TOKEN,
                      detail: "Token is invalid or expired.",
                    }
        "409":
          description: Conflict
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
              examples:
                already_exists:
                  value:
                    {
                      code: RESOURCE_ALREADY_EXISTS,
                      detail: "An account with this email already exists.",
                    }
```

This is the mechanical link between the code catalog and a caller's ability to discover an error before hitting it in production. An error code that exists in the catalog but in no endpoint's documented examples is effectively undiscoverable. Where tooling allows, generate the published catalog page and these examples from the spec so they cannot drift apart.

## Request-ID wiring

Return the ID on every response as a header, and echo it inside the error body so it survives a copy-paste into a support ticket without the header being separately captured:

```http
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json
X-Request-ID: req_7c8d9e0f

{
  "type": "https://api.example.com/errors/forbidden",
  "title": "Forbidden",
  "status": 403,
  "code": "INSUFFICIENT_PERMISSIONS",
  "detail": "This API key lacks the 'accounts:write' scope.",
  "request_id": "req_7c8d9e0f"
}
```

Then instruct integrators, in the docs and in the support-ticket form, to include `request_id` - it converts "I got an error, here's what I saw" tickets into "here's the request ID" tickets the provider can trace in one lookup.

## Catalog page shape

One public page, one stable anchor per code, so `documentation_url` always has a target:

```markdown
## VALIDATION_ERROR (HTTP 400) {#VALIDATION_ERROR}

The request body failed validation. The `errors` array names each failing
field, the value received, and the constraint violated. Not retryable -
fix the request before resending.

## RATE_LIMITED (HTTP 429) {#RATE_LIMITED}

Too many requests in the current window. Retryable - wait the number of
seconds given in `Retry-After` (also echoed in the body's `retry` object).
```

Per code, state:

- the HTTP status it rides on
- what causes it
- whether it is retryable
- whether its `message` is safe to show end users
- the fix path

Add a code here before it ships - never after a support ticket forces it.

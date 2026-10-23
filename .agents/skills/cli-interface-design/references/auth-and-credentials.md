# Auth and credentials

## Flows by context

| Context | Flow | Shipped example |
|---|---|---|
| Desktop with a browser | Authorization code + PKCE, loopback redirect (RFC 8252) | gcloud browser login (localhost redirect) |
| No local browser or port: SSH, containers, dev boxes | Device authorization grant (RFC 8628) | `gh auth login` uses it by default, opening a browser where one exists |
| CI and scripts | Scoped, expiring token in an env var | `GH_TOKEN`; flyctl app-scoped deploy tokens with expiry; `CLOUDFLARE_API_TOKEN` |
| API keys only | Key from stdin, or open the dashboard page that creates one | `gh auth login --with-token`, `stripe login --api-key` |
| Pairing to a dashboard | Pairing phrase confirmed in the web app, which issues a restricted key | `stripe login` |

Device-grant client rules (RFC 8628): show the user code and verification URL, poll no faster than the returned `interval` (5 seconds by default), and on `slow_down` add 5 seconds to the interval for every later poll.

Device-code phishing: an attacker can start a device flow and send the user code to a victim, who then authorizes the attacker's session. Require from the authorization server short-lived codes and a consent page naming the requesting client and location (`samber/developer-platform-skills@oauth2-provider-design` territory), and prefer the loopback flow wherever a local browser exists.

## API keys only

- Ask the API team for scoped, expiring keys and a test mode; list them as dependencies in the spec.
- Default the CLI to test mode where the API has one (Stripe's CLI acts on the sandbox unless `--live` is passed) and show the mode in `auth status` and before every severe action.
- A key read from stdin goes to the credential store like any token.

## Precedence

- Flag > env var > stored profile. Document it, and surface the winner in `auth status`.
- Vercel: `--token` beats `VERCEL_TOKEN`, but Vercel recommends the env var because a flag exposes the token in process lists.
- Cloudflare: `CLOUDFLARE_API_TOKEN` "overrides all profiles"; Doppler: a service token "always takes precedence".
- Multi-account trap: an env token silently overriding the logged-in account. Print a notice on stderr when it happens.

## Storage

- OS credential store first (Keychain, Windows Credential Manager, Secret Service).
- No credential store: warn on stderr before writing a plaintext file, owner-only permissions, and say where the file is. GitHub's CLI falls back to a plaintext hosts file, and an open issue shows tokens landing there even when a keyring existed.
- Never write tokens into a project-directory config a repo might commit.
- Prefer short-lived tokens with refresh; lock the store so parallel invocations do not race a refresh.

## Leak incidents

- CVE-2023-36052: Azure CLI commands printed secrets into GitHub Actions and Azure DevOps logs; fixed by default redaction.
- "LeakyCLI" research reported similar output in AWS and Google Cloud CLIs; both vendors treated it as expected behavior. Default redaction is a design choice, not a given.
- s1ngularity (August 2025): malicious package versions ran a post-install script that called `gh auth token` to harvest GitHub tokens, then launched installed AI coding CLIs with permission-bypass flags to inventory more secrets. GitGuardian counted 2,349 leaked credentials from 1,079 systems.

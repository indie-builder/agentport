# CLI design spec template

Fill every section. An empty section is a decision not yet made: list it under Open items with an owner. Every default value (limit, timeout, retry count) carries a one-line reason.

```markdown
# <CLI name> design spec (v<spec version>)

## Assumptions
| Question | Answer or assumption | What it changes |

## Answer to the requester
<What is reachable on day one, through which layer, and what promotes the generated layer later.>

## Audiences and jobs
| Job | Audiences (human / CI / agent) | API calls involved | Local-only part |

## Command layers
- Chosen rung and the interview answers that moved it
- Escape hatch: `<cli> api <method> <path>` - inherited flags and guards
- Starved option and its promotion trigger

## Grammar
- Order: noun verb | verb noun (reason)
- Verb set with meanings
- Command tree (top two levels); reserved names for extensions

## Contract surface
- Frozen: commands, flags, env vars, config keys, --json shapes, exit codes, stream rules
- Unstable: human output (stated in docs at <link>)
- Enforcement: JSON Schema per --json command, contract tests against <test environment>

## Configuration
- Precedence: flag > env > project config > user config > default
- Env prefix, profiles, config location, proxy and CA support

## Output and exit codes
- --json coverage (exceptions with reason)
- List envelope, error object
- Exit-code table: code | meaning | caller action

## Auth
| Context | Flow | Token type, scope, lifetime | Available now? |
- Storage and fallback; auth status / logout; token-print command: yes or no, and for whom

## Lists and long-running operations
- Default --limit (reason), --all, truncation fields
- Default --wait-timeout (reason), --no-wait, wait <operation-id>, Ctrl-C behavior
- Idempotency keys and automatic retry count (reason)

## Errors and help
- Error rewrite rules, request ID, did-you-mean
- Help topics, examples per command, completion shells, --debug trace

## Severity table
| Command or method + path | Grade (mild / moderate / severe) | Terminal behavior | Non-interactive flag |

## Agent readiness
- Self-description command
- Default fields and limits
- Token to hand an agent (test mode, read-only, scoped)

## Versioning and lifecycle
- CLI SemVer; pinned API version; override flag
- Deprecation window; alias policy
- Update-check rules
- Telemetry posture, off switches, payload schema link

## API-side dependencies
| Need (scoped keys, idempotency, operation status endpoint, ...) | Owner | Blocks which command |

## Release cut line
| Command or capability | v1 | later | Reason |

## Open items
| Decision | Owner | Due |

## Gates
- [ ] Contract coverage
- [ ] Non-interactive run
- [ ] Exit-code table tested
- [ ] Severe-action guard (curated and api)
- [ ] Secret hygiene
```

# Agent readiness and documented incidents

## Contents

1. Agent requirements
2. CLI versus MCP evidence, labelled
3. Documented failures

## 1. Agent requirements

| Requirement | Shipped or published example |
|---|---|
| Structured output by flag | `--json`, `--output json` |
| Non-interactive path | Speakeasy's `--skip-interactive`; a proposed `NO_PROMPT=true` for GitLab's CLI |
| Self-description | `gws schema`, `linear capabilities --json` |
| Validation before mutation | `--dry-run` |
| Input hardening | "Agents hallucinate. The CLI must be the last line of defense" (Justin Poehnelt) |
| Bounded output | small default `--limit`, minimal default fields, totals, explicit empty results |

- Speakeasy reported that agents "would start a workflow, hit an interactive prompt, and get stuck"; the fix was flags for every prompt, not removing prompts for humans.
- Anthropic's Claude Code best practices call CLI tools "the most context-efficient way to interact with external services" and suggest prompting the agent to read a tool's `--help`. Help text is an agent interface.
- An open-source agent-ergonomics standard (AXI) reports a wrapped GitHub CLI completing 100% of benchmark tasks against 86% for the plain CLI, on one model. Treat it as directional.

## 2. CLI versus MCP evidence, labelled

| Claim | Label |
|---|---|
| A five-server MCP setup can consume about 55k tokens in tool definitions | Anthropic engineering post, for five servers together, not one |
| GitHub's MCP server alone: about 11k tokens by default, about 23k with every toolset | community measurement, one version |
| MCP uses "4-32x more tokens" than a CLI | vendor-published, not independently measured |
| CLI and MCP are close in success rate and cost once tool design is controlled for | one practitioner benchmark, known only through a summary |

Position to carry: a CLI suits terminal-native coding agents and CI; an MCP server suits non-developer clients, products without a CLI, and per-user OAuth governance. Tool design moves results more than the protocol does. Never cite a ratio from this table as settled.

## 3. Documented failures

- **Default pager (AWS CLI v2, 2019):** all output went through a pager by default; scripts blocked until someone pressed `q`. A commenter on the pull request objected that it broke scripts using the CLI. The `AWS_PAGER` override existed at launch; the `--no-cli-pager` flag came later.
- **Return codes (AWS CLI v1 to v2):** AWS lists "more consistent return codes" among the v2 breaking changes - an exit-code change is a contract change.
- **Default-on telemetry (GitHub CLI v2.91.0, April 2026):** pseudonymous telemetry enabled by default in a minor release, announced in release notes and docs with no standalone blog post, justified by agent-driven growth; the payload carries an `agent` field. Off switches: `GH_TELEMETRY=false`, `DO_NOT_TRACK=true`, `gh config set telemetry disabled`. Not collected against GitHub Enterprise Server. The Register framed it as opting all CLI users in "whether they want it or not"; clig.dev had warned users "will find out, and they will be angry".
- **Token pivot (s1ngularity, August 2025):** malware called the GitHub CLI's `auth token` command to harvest stored tokens, then ran AI coding CLIs with permission-bypass flags. Design lesson: `auth token` and permission-bypass flags are attack surface.
- **Missing machine output:** flyctl's `deploy` has no `--json`, the long-running mutating command scripts most need to parse.

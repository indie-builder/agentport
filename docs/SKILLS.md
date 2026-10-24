# 项目技能清单（skills.sh）

> 已安装到 `.agents/skills/`，Claude Code 经 `.claude/skills/` 符号链接读取，版本锁定在 `skills-lock.json`。
> 本表说明各技能用途；增删以 `skills-lock.json` 为准。

| 技能 | 来源 | 安装量 | 对应项目技术栈 |
|---|---|---|---|
| `frontend-design` | anthropics/skills | 1.0M | 整体 UI 方向与排版 |
| `api-and-interface-design` | addyosmani/agent-skills | 60.7K | REST 接口契约、TypeScript 类型边界与错误语义 |
| `cli-interface-design` | samber/developer-platform-skills | 7.2K | 在 API 之上设计 CLI：命令分层、`--json`/退出码冻结契约、agent 友好 |
| `public-api-design-review` | samber/developer-platform-skills | 7.2K | REST 面检查表：命名、方法/状态码、分页、错误信封、Hyrum's Law 兼容 |
| `api-error-design` | samber/developer-platform-skills | 7.2K | 错误码 taxonomy、RFC 9457 problem-details、retryable 信号 |
| `api-integration-surface-strategy` | samber/developer-platform-skills | 7.2K | 按回滚成本与受众排序 REST/CLI/SDK/MCP 等各集成面的建设顺序 |
| `vercel-react-best-practices` | vercel-labs/agent-skills | 818.5K | React 19 组件与性能 |
| `supabase-postgres-best-practices` | supabase/agent-skills | 451.7K | PostgreSQL 18 查询、索引、RLS |
| `test-driven-development` | obra/superpowers | 254.7K | Vitest 单元/集成测试 |
| `verification-before-completion` | obra/superpowers | 246.1K | 交付前的验证纪律 |
| `shadcn` | shadcn-ui/ui | 115.4K | 组件库（本项目唯一 UI 组件来源） |
| `tailwind-design-system` | wshobson/agents | 69.4K | Tailwind 4 token 与设计系统 |

- 新增/更新：`npx skills add <repo> --skill <name> -y`，之后把 `skills-lock.json` 一起提交。
- 不安装与本项目栈冲突的技能（例如以 Playwright 为主的 `webapp-testing`，本项目 E2E 已统一为 `e2e`）。

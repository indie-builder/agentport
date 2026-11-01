# 安装 test-audit 技能（测试用例价值审计）

## 目标

为「哪些测试用例有用、哪些没用」提供可重复执行的技能：按证据判断低价值测试（无断言、自证期望值、断言实现细节、重复覆盖、只为维持测试专用接缝等），裁减前要求覆盖率与 keeper 测试证据，禁止为凑数量删不确定用例。

用户 2026-11-01 确认按推荐方案安装 mblode/agent-skills 的 `test-audit`。

## 方案

- 来源：`mblode/agent-skills`（MIT，178★，最近推送 2026-10-29），只装 `test-audit` 一个技能。
- 按 `docs/SKILLS.md`：`npx --yes skills@latest add mblode/agent-skills --skill test-audit --agent claude-code --agent universal -y`，保留上游正文，只补 `Project convention` 顶部段落。
- 适配要点：Vitest 5.0.5 与根 `vitest.config.ts` 的 backend/web projects；Docker/PostgreSQL/Redis 由 globalSetup 每轮提供隔离资源，`skipIf` 是设计内跳过、不得盲目 unskip；覆盖率门禁对准 `@vitest/coverage-v8`；不删除 E2E（统一 `e2e`）；不新增阻塞钩子；审计产出中文，删除按任务 worktree + 子代理执行。
- 同步 `docs/SKILLS.md` 清单与说明；`skills-lock.json` 由 CLI 写入上游 hash，不手改。

## 基线与范围

- 起点：`origin/main` = `c775e2d12b2f8e6df573318aa79f174a985ca364`，worktree `.claude/worktrees/test-audit-skill`，初始差异为空。
- 允许改动：`.agents/skills/test-audit/**`、`.claude/skills/test-audit` 链接、`skills-lock.json`、`docs/SKILLS.md`、本任务记录。
- 不改业务代码、测试、CI、依赖版本。

## 当前有效决定

- 用户 2026-11-01：「按你的建议来」→ 安装 mblode `test-audit` 并做项目适配，不安装 fcakyon 插件与其它候选。

## 已替代项及原因

- fcakyon/claude-codex-settings 的 test-audit（1194★）：覆盖新测试准入，范围更宽；本次诉求是审计并裁剪既有用例，选更聚焦的 mblode。
- NeuraCerebra-AI/testprune：0★、2026-09 后未更新，不满足维护度要求。

## 步骤

- [x] 记录安装前状态（技能目录、lock、CLI 版本）。
- [x] 安装技能并核对目录、链接与 lock hash。
- [x] 补 `Project convention` 适配（Vitest / 隔离基础设施 / E2E / 门禁）。
- [x] 更新 `docs/SKILLS.md`。
- [x] 核验：CLI 列表、目录实物、lint。

## 改动文件

- `.agents/skills/test-audit/SKILL.md`（仅新增 `Project convention`）
- `.agents/skills/test-audit/references/{campaign.md,coverage.md}`、`.agents/skills/test-audit/evals/evals.json`（CLI 原样安装）
- `.claude/skills/test-audit` → `../../.agents/skills/test-audit`
- `skills-lock.json`
- `docs/SKILLS.md`
- `docs/tasks/test-audit-skill.md`

## 下一步

- 交付：等待当次授权后提交；不 commit、不 push。

## 验证

- 安装前：`npx --yes skills@latest --version` = `1.7.4`；`.claude/skills` 与 `.agents/skills` 仅有 `test-driven-development`、`vitest` 匹配 `test`，无 `test-audit`；`skills-lock.json` 无 `test-audit`；上游 `gh api` 返回 `license=MIT`、`stars=178`、`pushed=2026-10-29T20:58:14Z`。
- 安装：`npx --yes skills@latest add mblode/agent-skills --skill test-audit --agent claude-code --agent universal -y` 退出 0，输出 `Found 28 skills` / `Selected 1 skill: test-audit` / `Installation complete` / `symlinked: Claude Code`。
- 实物：`.agents/skills/test-audit/` 含 `SKILL.md`、`references/{campaign.md,coverage.md}`、`evals/evals.json`；`.claude/skills/test-audit` 为相对链接；`skills-lock.json` 记录 `source=mblode/agent-skills`、`computedHash=5977839596c7ec985b06298b1b40acb07a0de1e0e3d4745f49d29665f346de87`（CLI 写入，未手改）。
- 上游比对：安装后 `diff -u <上游 SKILL.md> .agents/skills/test-audit/SKILL.md` 仅显示新增的 `Project convention` 段，正文其余逐字节一致。
- `npx --yes skills@latest list` 出现 `test-audit`，路径为当前 worktree 的 `.agents/skills/test-audit`，来源 `mblode/agent-skills`。
- `pnpm exec biome check docs/SKILLS.md skills-lock.json .agents/skills/test-audit` 退出 0。
- 覆盖率 provider 实测：`pnpm exec vitest run --coverage --project web --passWithNoTests no-such-test-file` 退出 0 并输出覆盖率摘要，`@vitest/coverage-v8` 可用（生成物 `coverage/` 已删除）。
- `pnpm lint` 全仓退出 1：失败集中在 `packages/api/src/features/**` 的既有格式/lint 问题（如 `knowledge/package-routes.ts`），与本次改动无关；已用 `git show HEAD:<file> | biome check --stdin-file-path=<file>` 复现同一失败，确认是基线问题。未修业务代码。
- 未改业务代码、测试、CI、依赖版本、其它技能；未 commit。

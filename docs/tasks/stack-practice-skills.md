# 技术栈实践技能补齐

## 目标

按前次技能评估的首批推荐补齐技能并完成项目适配，同时按用户要求引入 Zustand 与 Effect 指导。全任务范围：

- 首批推荐 5 个方向（含 Table 官方技能）：
  - `docker/skills` → `docker-build-strategies`、`docker-compose-patterns`
  - `anthropics/skills` → `mcp-builder`
  - `vercel-labs/agent-skills` → `vercel-composition-patterns`
  - `tanstack/table` → `getting-started`（React 入口，配套技能读 npm 包内文件）
- Zustand 统一管理状态（`prowler-cloud/prowler` → `zustand-5`）、Effect 使用指导（`effect-ts/skills` → `effect-ts`）。

7 个技能均已完成安装与适配；首批 4 个技能在本轮未重复改动。本轮只安装技能，不全仓迁移业务、不升级依赖。

验收入口：新增目录与 `.claude/skills` 相对链接准确；`skills list` 与 `skills-lock.json` 一致；diff 不含既有技能改动、依赖无变化；逐文件与固定上游对比只允许 `Project convention`、license、`zustand-5` 的 `allowed-tools` 行移除与明确列出的 Table 路径适配差异，并提供对比证据。

## 方案

- 先核对 `skills` CLI 版本/帮助与三个上游仓库的技能清单、固定提交、许可。
- 用官方 CLI 定向 `add`，每个技能一次，参数 `--skill <name> --agent claude-code --agent universal -y`，保证 canonical 目录在 `.agents/skills/`、`.claude/skills/` 为相对链接；只新增，不 `update` 既有技能。
- `references/` 及上游其余文件保持原样；只允许 `SKILL.md` 顶部补充项目约定（及 CLI 未带上的上游 license）。
- `Project convention` 只写项目关键边界与和上游明确冲突之处，按任务需求做最小完整改动，不把当前文件细节固化成不可变的架构约束；技能内脚本可按内容与当次授权使用。
- `skills-lock.json` 保留 CLI 写入的上游 hash，不按本地适配内容改写。
- Table、Zustand、Effect 沿用同一流程继续处理。
- 固定 commit URL 由官方 CLI 直接安装，`ref`、`computedHash` 保留 CLI 写入值，不手造 hash。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/stack-practice-skills`
- 基线 commit：`e87704bf093c87dab932d61b1d98580d17e2b6cf`，与 `origin/main` 相同。
- 初始未提交差异：无（`git status --porcelain` 为空）。
- 本任务允许写入：`.agents/skills/` 下 7 个技能目录、`.claude/skills/` 对应相对链接、`skills-lock.json`、`docs/SKILLS.md`、本任务记录。
- 不修改：既有技能、依赖、业务代码、构建与 Compose 文件。续做时另有规则代理并行修改 `docs/ARCHITECTURE.md`、`docs/EFFECT.md`、`packages/*/CLAUDE.md`、`packages/core/src/effect-runtime.ts`，不属于本任务，本任务不触碰。

## 当前有效决定

- 用户 2026-10-31：按建议补齐技能；状态统一引入 Zustand 管理，并引入 Effect 指导。首批推荐共 5 个方向（含 Table），4 个技能先装属主会话内部执行分批，不代表剩余项取消。
- 用户 2026-10-31（最新）：按成熟主流官方用法执行，不反复询问；Table 只装 React 入口，其余官方技能读已安装 npm 包内文件，不安装 `intent`、不新增依赖。
- 技能安装到 `.agents/skills/`，Claude Code 经 `.claude/skills/` 相对符号链接读取；两个 agent 参数缺一不可。
- 适配原则：以 `SKILL.md` 顶部 `Project convention` 为主，引用文件保持上游原样；Table 的 `intent load` 与失效相对链接按明确边界改为包内真实路径。不因指南默认改动现有 Dockerfile / docker-compose.yml / worktree 共享基础设施 / MCP 架构 / UI 视觉。
- 用户 2026-10-31（最新，覆盖此前阶段）：『提交 PR 并合并。然后收尾』——授权本任务 commit、push、创建 PR 并合并；合并后按 `docs/DEV-WORKFLOW.md` §2-7 收尾：清理本任务 worktree、退出回主 checkout、主 checkout 的 main 快进到最新 `origin/main`。

## 已替代项及原因

- 旧阶段「不 commit、不 push」是用户授权前的历史表述，已由最新授权覆盖，不再是当前决定；commit/push/PR/merge 与收尾现按上方最新决定执行。
- 另修正过任务记录把内部执行分批误记为用户决定的问题，用户决定本身未变化。

## 步骤

- [x] 读取项目规则、`docs/DEV-WORKFLOW.md` §2、`docs/PITFALLS.md`、`docs/SKILLS.md`，确认基线与目录现状。
- [x] 核对 `skills` CLI 版本/帮助、三个上游仓库的技能清单，记录固定提交与许可。
- [x] 用 CLI 定向安装 4 个技能，核对 canonical 目录与相对链接。
- [x] 为每个 `SKILL.md` 补 `Project convention`；为 CLI 未带上的上游 license 在新技能目录补副本（docker 两个）。
- [x] 逐文件与固定上游快照对比，确认差异仅限允许项。
- [x] 核对 `skills list`、`skills-lock.json`、diff 与依赖状态。
- [x] 更新 `docs/SKILLS.md` 清单与首批 4 个技能的适配说明，并按当次 CLI 实物修正 `metadata.json` 的固定假设。
- [x] 精简四个 `Project convention`，只保留项目关键边界与上游明确冲突。
- [x] 安装并适配 Table 官方技能。
- [x] 补齐 Zustand 与 Effect 指导。
- [x] 逐文件与固定上游对比新增 3 个技能，核对链接、lock、CLI 集合与包内引用。
- [x] 独立 Opus 终审通过：无 P0-P2；P3 的 MCP 包版本书写已修正为 `@modelcontextprotocol/node` 2.1.2、`@modelcontextprotocol/server` 2.4.0。

## 改动文件

- `.agents/skills/docker-build-strategies/`
- `.agents/skills/docker-compose-patterns/`
- `.agents/skills/mcp-builder/`
- `.agents/skills/vercel-composition-patterns/`
- `.agents/skills/zustand-5/`
- `.agents/skills/effect-ts/`
- `.agents/skills/getting-started/`
- `.claude/skills/docker-build-strategies`、`docker-compose-patterns`、`mcp-builder`、`vercel-composition-patterns`、`zustand-5`、`effect-ts`、`getting-started`（相对链接）
- `skills-lock.json`
- `docs/SKILLS.md`
- `docs/tasks/stack-practice-skills.md`

## 下一步

7 个技能已安装、适配并登记到 `docs/SKILLS.md`，独立 Opus 终审已通过，任务范围内无剩余实现步骤。用户已明确授权 commit/push、创建 PR 并合并，以及合并后收尾（清理本任务 worktree、主 checkout 快进 main）。截至本记录更新时，提交、PR 创建与合并尚未执行，不视为完成；执行后以 PR 的真实合并状态为准再按 §2-7 删树与快进 main。

## 验证

工具版本：`skills` CLI 1.7.4（`npx --yes skills@latest --version`），Claude Code 2.1.316；安装参数均为 `--skill <name> --agent claude-code --agent universal -y`。

固定上游（`git rev-parse HEAD`，与安装后逐文件对比所用快照一致）：

| 技能 | 上游 | commit |
|---|---|---|
| `docker-build-strategies`、`docker-compose-patterns` | `docker/skills` | `34969c320b839772a26f3855d3e87cc3d8090da1` |
| `mcp-builder` | `anthropics/skills` | `ca45fc496a3436251f191354091d557da31c15b5` |
| `vercel-composition-patterns` | `vercel-labs/agent-skills` | `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62` |

许可：

- `docker/skills`：仓库根 `LICENSE` 为 Apache-2.0；CLI 只复制技能目录，已把同一文件复制到两个 docker 技能目录。
- `anthropics/skills`：`mcp-builder/LICENSE.txt` 位于技能目录内，CLI 已原样安装（Apache-2.0）。
- `vercel-labs/agent-skills`：上游仓库与该技能目录都没有 LICENSE 文件；`SKILL.md` frontmatter 声明 `license: MIT`，此处只记录来源事实，不伪造许可证文本。

对比证据：`diff -ru <固定上游技能目录> .agents/skills/<技能目录>`（`composition-patterns` 对照 `skills/composition-patterns`）。结果只显示：

- 四个 `SKILL.md` 在 frontmatter 后各新增 1 段 `Project convention`；
- `docker-build-strategies`、`docker-compose-patterns` 各新增与上游根 `LICENSE` 相同的 `LICENSE`。

其余 `agents/`、`assets/`、`checks/`、`references/`、`reference/`、`rules/`、`scripts/`、`skill.yaml`、`AGENTS.md`、`README.md`、`metadata.json`、`LICENSE.txt` 逐字节一致。`vercel-composition-patterns` 的 `metadata.json` 本次被 CLI 一并复制，内容与上游一致。

CLI 与链接：

- `skills list --json` 显示 4 个技能，`scope: project`，`source` 分别为 `docker/skills`、`anthropics/skills`、`vercel-labs/agent-skills`。
- `.claude/skills/{docker-build-strategies,docker-compose-patterns,mcp-builder,vercel-composition-patterns}` 均为 `../../.agents/skills/<name>` 相对链接，无断链。
- `skills-lock.json` 新增 4 条，`skillPath` 分别为 `skills/docker-build-strategies/SKILL.md`、`skills/docker-compose-patterns/SKILL.md`、`skills/mcp-builder/SKILL.md`、`skills/composition-patterns/SKILL.md`，`computedHash` 保留 CLI 上游值，未按本地适配改写。

范围与依赖：

- `git diff --stat` 仅 `skills-lock.json | 24 +`；既有技能目录无改动。
- `git status` 只含 4 个新技能目录、4 个新相对链接、`skills-lock.json` 与本任务记录。
- `git status --porcelain -- package.json pnpm-lock.yaml pnpm-workspace.yaml packages` 输出为空，依赖与业务代码无变化。
- 未执行任何技能内 `scripts/` 脚本，未安装技能业务依赖。

文档修正（2026-10-31）：`git diff --stat` 仅 `docs/SKILLS.md`（17 行新增、3 行修改）与安装产生的 `skills-lock.json`（24 行新增）；四个新技能 `SKILL.md` 行数与安装时一致（168/173/254/91），每个文件只有 1 处 `Project convention`，正文其余内容未动。

## 续做验证（2026-10-31，Zustand / Effect / Table）

工具：`skills` CLI 1.7.4。安装命令均为 `npx --yes skills@latest add <固定 commit URL> --skill <name> --agent claude-code --agent universal -y`，未使用 `--copy`。

固定上游与许可：

| 技能 | 上游 | 固定 commit | 许可 |
|---|---|---|---|
| `zustand-5` | `prowler-cloud/prowler` | `67aa9410127c7228fed304f3333b271808ba0c8d` | Apache-2.0，补上游根 `LICENSE` |
| `effect-ts` | `effect-ts/skills` | `155c50c911f9c99c294ef8a4461981c5bbe6453e` | MIT，补上游根 `LICENSE` |
| `getting-started` | `tanstack/table` | `c14e0221b1e656c7bb35e7b3d4cdf188719a3599` | MIT，补上游根 `LICENSE` |

对比证据（`diff -ru <固定上游技能目录> .agents/skills/<name>`）：

- `zustand-5`：多 `LICENSE`；`SKILL.md` 多 1 段 `Project convention`，并移除上游 frontmatter 的 `allowed-tools` 预授权行（技能只作只读指导，避免激活时预授权写文件、执行命令与派子代理），其余 frontmatter、正文与其余文件逐字节一致。
- `effect-ts`：只多 `LICENSE`，`SKILL.md` 只多 1 段 `Project convention`，其余逐字节一致。
- `getting-started`：多 `LICENSE`；`SKILL.md` 的 `description` 收窄为 TanStack Table v9 React 并新增 `Project convention`，入口 `intent load` 改为直接读 core 包内文件，`../table-state`、`../migrate-v8-to-v9` 改为 React 包内真实路径；`references/{create-table-hook,with-tanstack-query,with-tanstack-virtual}.md` 各只改首段 `../../table-state` 链接（`with-tanstack-query.md` 另把 `intent load @tanstack/table-core#table-features` 改为直接读 core `table-features`），其余内容逐字节一致。`with-tanstack-query.md` 属同一类失效相对链接，虽未在最初两项中点名，按“包内引用真实存在”的验收一并修正。
- 三个技能均未生成 `metadata.json`。

包内引用与文档：

- Table React 路径 `readlink -f packages/web/node_modules/@tanstack/react-table` 解析到 `.pnpm/.../node_modules/@tanstack/react-table`；同层 `../table-core` 解析到 `.pnpm/@tanstack+table-core@9.3.1/node_modules/@tanstack/table-core`，不手写 `.pnpm` 版本。
- 已实际存在：React `skills/table-state/SKILL.md`、`skills/migrate-v8-to-v9/SKILL.md`；core `skills/{core,table-state,table-features,custom-features,migrate-v8-to-v9}/SKILL.md`、`table-features/references/client-vs-server.md`。
- 用脚本解析 `getting-started` 全部 Markdown 相对链接，8 个链接全部 `OK`；正文已无未处理的 `intent load` 命令。
- Effect：`packages/core/node_modules/effect/AGENTS.md` 与 `src/` 存在，根 `node_modules/effect` 不存在，与约定一致；已安装的 `effect@4.0.6` 包内没有 `ai-docs` 目录，约定只指向实际存在的 `src`。
- 依赖先用 `pnpm install --frozen-lockfile` 安装（退出 0），未改 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`。

集合与链接：

- `skills-lock.json` 46 条 = `.agents/skills/` 46 个目录 = `.claude/skills/` 46 个有效相对链接 = `skills list --json` 46 条，无单边差集。
- 链接均为 `../../.agents/skills/<name>`，无自定义目标。
- 新增 lock 条目保留 CLI 写入的 `ref` 与 `computedHash`；原 4 个技能条目及其目录未写入。
- `git status` 中 `docs/ARCHITECTURE.md`、`docs/EFFECT.md`、`packages/*/CLAUDE.md`、`packages/core/src/effect-runtime.ts` 的改动来自并行的规则代理，不在本任务范围；本任务只改技能目录/链接、`skills-lock.json`、`docs/SKILLS.md` 与本记录。
- 未执行任何外部技能脚本，未构建业务工程。

## 最终核验（2026-10-31）

以下均为实际运行结果：`git diff --numstat -- skills-lock.json` 为 `45 0`（45 新增、0 删除）；`skills-lock.json` 46 条 = `.agents/skills/` 46 个目录 = `.claude/skills/` 46 个相对链接，断链 0；Table `getting-started` 全部 Markdown 相对链接 8 条、缺失 0，正文无未处理的 `intent load`（唯一命中位于 `Project convention` 的替换说明内）；`pnpm --filter @agentport/core typecheck` 退出 0；`node scripts/check-focus-contract.mjs` 输出「焦点/边框规约校验通过」、`node scripts/check-project-contract.mjs` 输出 `project contract OK`，均退出 0；`pnpm install --frozen-lockfile` 退出 0。依赖/manifest/Dockerfile/compose 无变化：`git status --porcelain -- package.json pnpm-lock.yaml pnpm-workspace.yaml Dockerfile docker-compose.yml docker-compose.yaml` 为空；`packages` 下仅有并行规则代理改动的 `CLAUDE.md` 与 `effect-runtime.ts`，不属本任务，也无依赖改动。未运行 web build 或业务测试（本任务未改动相关代码）。

终审已修复 3 处 P2 文档问题：`docs/SKILLS.md` 的 React 组合技能状态归属补全 TanStack Router 与 OpenUI 运行时；core Effect 桥接签名规则限定为仅约束桥接层；Docker 约定删除不存在的 `apk` 固定 digest 要求。

独立 Opus 最终 review（2026-10-31）：通过，无 P0-P2。唯一 P3 为 `docs/SKILLS.md` 中 MCP 包版本写法有误，已修正为 `@modelcontextprotocol/node` 2.1.2、`@modelcontextprotocol/server` 2.4.0。该修正之后未再改技能内容与其余文档；本次只在任务记录中补充授权、终审结论与收尾状态。

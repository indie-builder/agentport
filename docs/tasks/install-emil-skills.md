# 安装 Emil Kowalski 技能（emilkowalski/skills）

## 目标

用户给出安装命令 `npx skills@latest add emilkowalski/skills`。按项目技能规则（`docs/SKILLS.md`：canonical `.agents/skills/` + `.claude/skills/` 相对符号链接 + `skills-lock.json`）决定采用**项目级**安装，不使用 `-g`。验收标准：

- 13 个新技能的 canonical 目录与 `.claude/skills/` 相对链接一致，链接指向当前 worktree 的 `.agents/skills/<name>`。
- `skills-lock.json` 每个新技能一条记录，`source` 为 `emilkowalski/skills`，`computedHash` 为上游 CLI 值。
- 原有 26 个技能的文件、链接、lock 条目均不受影响。
- 当时未授权提交；用户后续已授权 commit / push / merge（见「当前有效决定」）。

## 方案（实际执行）

- CLI 实测：`npx --yes skills@latest --version` → `1.7.4`；`npx --yes skills@latest add emilkowalski/skills --list` → 上游共 16 个技能。
- 选定 13 个桌面 Web 技能：`emil-design-eng`、`animate`、`review-animations`、`improve-animations`、`find-animation-opportunities`、`remove-animations`、`animation-performance`、`animation-vocabulary`、`apple-design`、`pick-ui-library`、`prototype`、`break-ui`、`ask-sonner`。
- 排除 3 个：`animate-expo`（React Native / Expo）、`write-swift`（Swift）、`mobile-native`（移动端），与本项目桌面 Web 栈不符。
- 安装命令（单写入者，带两个 `--agent` 以生成 canonical 目录与相对链接）：

  ```
  npx --yes skills@latest add emilkowalski/skills --skill emil-design-eng animate review-animations improve-animations find-animation-opportunities remove-animations animation-performance animation-vocabulary apple-design pick-ui-library prototype break-ui ask-sonner --agent claude-code --agent universal -y
  ```

- 安装结果：13 个 `.agents/skills/<name>/`（20 个上游文件）+ 13 个 `.claude/skills/<name>` 相对链接；`skills-lock.json` 新增 13 条。
- 上游技能目录本身不含 `metadata.json`；CLI 只复制技能目录内容，未复制仓库根 `README.md`、cheatsheet 与 `LICENSE`。
- 适配：每个 `SKILL.md` 在 frontmatter 后加一段中文 `Project convention`；`description`、`name` 与其余引用文件保持上游原样。上游 `LICENSE`（MIT，Copyright (c) 2026 Emil Kowalski）复制到 13 个新技能目录，是相对上游唯一新增的文件。

## 基线与范围

- 起始 `HEAD` = `ecc288838b4dd3be8b646ee98e0f4e1a5aa67bda`。建树（worktree）最初没有未提交差异；执行代理接手时工作树里只有本任务记录，没有他人或其他代理的改动。基线即该 `HEAD` 加本记录，后续所有差异均由本任务产生。
- 安装前：`.agents/skills/` 26 个目录、364 个受版本控制文件；`.claude/skills/` 26 个链接；`skills-lock.json` 26 条。
- 允许改动：新增的 13 个 `.agents/skills/*` 与对应 `.claude/skills/*` 相对符号链接、`skills-lock.json`、`docs/SKILLS.md`、本记录。
- 不允许：既有 26 个技能、产品代码、依赖与锁文件。（当时未授权 commit / push / merge，该限制已由用户后续授权替代。）

## 当前有效决定

- 用户给出安装命令，项目级由 `docs/SKILLS.md` 规则决定，不使用全局作用域。
- 13/16 选择仅桌面 Web 技能，排除项按技术栈不符处理。
- 适配只加 `SKILL.md` 顶部中文 `Project convention` 与各目录 `LICENSE`；不机械扩写其他内容。
- 技能特有约定：`animate` 键盘/高频交互按项目规范；`improve-animations` 计划写 `docs/tasks/` 且以 DESIGN-SYSTEM 为准；`remove-animations` 依赖清理按当次授权；`prototype` picker 用项目组件与 token；`break-ui` 只按桌面范围验证；`pick-ui-library` 遵守项目选型顺序；`ask-sonner` 复用现有唯一 Toaster。均写入对应 `SKILL.md` 与 `docs/SKILLS.md`。
- 交独立 review；review 通过后按用户授权 commit / push / merge（原「不提交」已替代）。

## 已替代项及原因

无。本记录原「用户要求以项目级方式安装」「本任务由文档代理只写本记录、不运行安装」的表述已按实际执行更正。

## 步骤

- [x] 读 `docs/SKILLS.md`、`docs/PITFALLS.md` 相关部分与 `ub-mode`，记录基线。
- [x] 实测 CLI 版本、帮助与 `add --list`，确认 16 个上游技能与 `metadata.json` 排除行为。
- [x] 上游快照记录：`git clone` 到临时目录，commit `a81dbca07f2217b7103e510c0f13f8d5b017afc9`。
- [x] 项目级安装 13 个技能（`--agent claude-code --agent universal -y`）。
- [x] canonical 核验：13 个 `.agents/skills/<name>/SKILL.md` 存在，`.claude/skills/<name>` 为相对链接，非真实目录。
- [x] lock 核验：新增 13 条，既有 26 条未动。
- [x] 原有技能核验：`git status` 只出现新增项与 lock 修改，无既有文件改动。
- [x] 补 `SKILL.md` Project convention 与各目录 `LICENSE`。
- [x] 更新 `docs/SKILLS.md` 清单与适配说明、本记录。
- [x] 独立 Opus review：第一轮 3 项已修复，第二轮定点复核通过；安装完整性、来源、锁与许可审查通过。

## 改动文件

- `.agents/skills/` 下 13 个新技能目录：`animate`、`animation-performance`、`animation-vocabulary`、`apple-design`、`ask-sonner`、`break-ui`、`emil-design-eng`、`find-animation-opportunities`、`improve-animations`、`pick-ui-library`、`prototype`、`remove-animations`、`review-animations`（共 33 个文件：20 个上游文件 + 13 个 `LICENSE`）。
- `.claude/skills/` 下 13 个相对符号链接。
- `skills-lock.json`（+13 条）。
- `docs/SKILLS.md`。
- `docs/tasks/install-emil-skills.md`（本记录）。

## 验证（2026-10-29 实测）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| CLI 版本 | `npx --yes skills@latest --version` | `1.7.4` |
| 上游清单 | `npx --yes skills@latest add emilkowalski/skills --list` | 16 个技能 |
| 数量一致 | `ls .agents/skills \| wc -l`、`ls .claude/skills \| wc -l`、`jq '.skills \| length' skills-lock.json` | 39 / 39 / 39 |
| CLI 视图 | `npx --yes skills@latest list --json` | 39 条，其中 13 条 `source=emilkowalski/skills` |
| 链接 | `find .claude/skills -maxdepth 1 -type l -exec readlink {} \;` | 39 条全部为 `../../.agents/skills/<name>`；无真实目录、无断链 |
| 既有技能 | `git status --porcelain`、`git ls-files .agents/skills \| wc -l` | 只有新增与 `M skills-lock.json`；跟踪文件仍 364 |
| lock 只增不改 | `git diff skills-lock.json` | 删除 0 行，新增 13 个 `computedHash` |
| 上游逐文件比对 | `diff -r -q <上游快照>/skills/<name> .agents/skills/<name>` | 13 个目录均只报 `Only in ...: LICENSE` 与 `SKILL.md` 不同；`RECIPES.md`、`API.md`、`CATALOG.md`、`AUDIT.md`、`PLAN-TEMPLATE.md`、`PICKER.md`、`STANDARDS.md` 完全一致 |
| 空白检查 | `git diff --check` | 无输出（覆盖已跟踪文件；新增文件由 `diff -r` 比对） |
| 本轮 review 修复后 | `git diff --check`、13 个目录 `diff -r -q`、SKILL.md `diff -u` | 退出 0；仍只有 `LICENSE` 新增与 `SKILL.md` 不同；13 个 `SKILL.md` 均只新增约定段、无删除行 |

无应用代码改动，未运行测试或构建。

## 上游快照

- 路径：`/tmp/emil-skills-upstream.TYVutE/repo`，commit `a81dbca07f2217b7103e510c0f13f8d5b017afc9`，供独立 review 比对；临时目录，review 结束后可删。
- `skills-lock.json` 保留 CLI 写入的上游 hash，不因本地适配改写。

## Review 记录

第一轮独立 Opus review 未通过，3 项均按明确的最小修法处理：

| # | 位置 | 问题 | 修复 |
| --- | --- | --- | --- |
| 1 | `animate/SKILL.md` Project convention | 末句「不要动画化键盘操作和高频交互」与项目既定的键盘及 hover/focus 反馈冲突 | 改为「键盘、高频交互与既定动效遵循项目规范，不套用上游一律禁止的规则；保留项目规定的 hover/focus 同等反馈。」 |
| 2 | `improve-animations/SKILL.md` Project convention | 未声明以 DESIGN-SYSTEM 为准，上游 `AUDIT.md`、`PLAN-TEMPLATE.md` 的硬性值会把项目已定动效误报为缺陷 | 新增「审计、建议及计划中的允许范围、属性、数值和 reduced-motion 行为均以 `docs/DESIGN-SYSTEM.md` 为准；本约定优先于本文件及 `AUDIT.md`、`PLAN-TEMPLATE.md` 的上游硬性要求，已明确的项目动效不得作为缺陷。」 |
| 3 | `remove-animations/SKILL.md` Project convention | 无条件「必须先经用户确认」与项目规则「已覆盖操作不重复确认」冲突，且未覆盖下文 Hard Rule 3 | 改为「依赖清理按当前任务授权与项目规则执行；已授权范围内确认零引用后直接清理，不重复确认，本约定覆盖下文 Hard Rule 3。」 |

状态：第二轮独立 Opus 定点复核通过，3 项冲突均已消除，任务基线表述已修正。安装完整性审查通过：39 个目录/锁记录/相对链接一致，13 个上游目录 hash 按 CLI 1.7.4 算法重算一致，原有 26 项不变；主会话修复后逐文件核验通过。

## 下一步

无安装待办。review 已通过（见上），用户现已授权交付：提交本任务差异 → push 分支 → 建 PR（base `main`）→ 合并；不等 CI、不跑应用测试与构建。合并后不删除本 worktree（由主会话处理）。

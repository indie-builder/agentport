# 安装 unslop 技能

## 目标
把上游 `heydamir/unslop` 的 `skills/unslop` 按项目技能 SOP 装进本仓库（项目级，`.agents/skills/unslop/` + `.claude/skills/unslop` 相对链接 + `skills-lock.json`），并登记 `docs/SKILLS.md`。

## 方案
用 `npx --yes skills@latest add heydamir/unslop --skill unslop --agent claude-code --agent universal -y` 安装，保留上游 `references/` 与 `scripts/` 原样；仅在 `SKILL.md` frontmatter 之后加一段中文 `Project convention`，并把上游根 `LICENSE`（CC-BY-4.0）补进技能目录。`skills-lock.json` 的 `computedHash` 保留 CLI 写入值。

## 基线与范围
- worktree：`<主 checkout>/.claude/worktrees/install-unslop-skill`，分支 `worktree-install-unslop-skill`
- 起点：`fb023bd`（`origin/main`），初始 `git status --porcelain` 为空
- 允许改动：`.agents/skills/unslop/`、`.claude/skills/unslop`、`skills-lock.json`、`docs/SKILLS.md`、本记录

## 当前有效决定
- 用户 2026-11-01：安装到项目级（非用户级），继续执行。
- 用户同时要求把这个安装记入长期记忆。

## 已替代项及原因
无。

## 步骤
- [x] 用 skills CLI 安装 `unslop`
- [x] `SKILL.md` 补 `Project convention`
- [x] 补上游 `LICENSE`
- [x] `docs/SKILLS.md` 清单与适配说明
- [x] 核验 lock、链接、目录与上游一致

## 改动文件
- `.agents/skills/unslop/`（CLI 安装，13 个上游文件 + 补入 `LICENSE`；`SKILL.md` 加 `Project convention`）
- `.claude/skills/unslop`（CLI 创建的相对链接 `../../.agents/skills/unslop`）
- `skills-lock.json`（新增 `unslop` 条目：`source` `heydamir/unslop`、`skillPath` `skills/unslop/SKILL.md`、`computedHash` `83dcbc85…1dbc`）
- `docs/SKILLS.md`（清单加一行、项目适配加 `### unslop（2026-11-01）`）
- `docs/tasks/install-unslop-skill.md`（本记录）

## 下一步
- 安装与核验完成后交付；未获授权不 commit/push/merge。

## 验证
上游快照：`git clone --depth 1 https://github.com/heydamir/unslop.git /tmp/unslop-upstream/repo`，HEAD `4652254daff586ff4739849395a127b56f7f8cc7`。

1. `npx --yes skills@latest add heydamir/unslop --skill unslop --agent claude-code --agent universal -y`（CLI 1.7.4）→ `Installation complete`，输出 `universal: Universal` + `symlinked: Claude Code`，路径为当前 worktree。
2. `npx --yes skills@latest list` → 含 `unslop … .agents/skills/unslop … Source: heydamir/unslop`，`Agents:` 命中 Claude Code。
3. `ls -la .claude/skills/unslop` → `unslop -> ../../.agents/skills/unslop`；`readlink -f` 解析到当前 worktree 的 `.agents/skills/unslop`。
4. `diff -r /tmp/unslop-upstream/repo/skills/unslop .agents/skills/unslop` → 差异只有两项：`Only in .agents/skills/unslop: LICENSE`，以及 `SKILL.md` 第 10 行后新增的 `## Project convention` 段；`references/`、`scripts/` 逐字节一致，frontmatter 未改。
5. `curl -fsSL https://raw.githubusercontent.com/heydamir/unslop/main/LICENSE -o .agents/skills/unslop/LICENSE` 后与克隆内 `LICENSE` 比对 → 完全一致。
6. `git status --porcelain` → ` M docs/SKILLS.md`、` M skills-lock.json`、`?? .agents/skills/unslop/`、`?? .claude/skills/unslop`、`?? docs/tasks/install-unslop-skill.md`。

# 安装 thesys 技能（thesysdev/skills）

## 目标

把用户指定的上游技能仓库 <https://github.com/thesysdev/skills> 中经核查确认的项目相关技能装入本项目，沿用 canonical `.agents/skills/` + `.claude/skills/` 相对链接结构，同步 `skills-lock.json` 与 `docs/SKILLS.md`。

## 安装范围

- 上游 CLI 发现结果：`npx --yes skills@latest add thesysdev/skills --list` → `Found 1 skill`，唯一技能 `openui`（`SKILL.md` + `references/` 14 个文件）。
- 结论：安装 `openui`，不排除、不拆分；上游无其他技能可装。
- 安装命令：`npx --yes skills@latest add thesysdev/skills --skill openui --agent claude-code --agent universal -y`。两个 `--agent` 缺一不可（只给 `claude-code` 会退化成 copy 模式，canonical 不更新）。已执行安装，并完成项目入口与既有技能完整性核验。

## 适配理由与内容

`openui` 面向 `@openuidev/*` 生成式 UI 技术栈，与本项目「shadcn/Base UI + Claude Agent SDK」不同源，因此只对 `SKILL.md` 做两处最小适配，`references/` 原样保留，`skills-lock.json` 的 `computedHash` 保持上游 CLI 值（lock 记录上游 hash，不因本地适配改写）。

1. `description` 收窄：仅用于明确涉及 OpenUI、OpenUI Lang、`@openuidev/*` 包、OpenUI Gateway、Autofix、`@openuidev/cli` 的任务；不用于普通 chat / agent / dashboard 需求，也不用于只借 openui.com 做视觉参考的场景（视觉基准是 `docs/DESIGN-SYSTEM.md`，与 OpenUI 技术栈无关）。
2. 正文 project convention：UI 用 shadcn/Base UI 与 Tailwind 4 现有 `@theme` token，遵守 `docs/DESIGN-SYSTEM.md`，不新建 app；运行底座只有 Claude Agent SDK，不默认切换到 Gateway / OpenAI / LangGraph，不引入外部存储或部署。

维护规则已写入 `docs/SKILLS.md`「项目适配 › openui」，更新后需补回；恢复用适配副本见下。

## 基线与范围

- 起始 HEAD `da56577c9d0c5224865c20c9d3faebbb6250eb5a`（与本地 `main` 一致），初始工作树干净；`skills` CLI `1.7.4`。
- 现状：`.agents/skills/` 13 个技能共 173 个受版本控制文件，`.claude/skills/` 13 个相对链接，`skills-lock.json` 13 条，无 `thesysdev/skills` 条目。本次实测 173 文件 / 13 链接与备份一致。
- 允许改动：新增 `openui` 技能目录与对应链接、`skills-lock.json`、`docs/SKILLS.md`、本记录。
- 不允许：产品代码、依赖与锁文件、既有技能内容与链接、其他文档。
- 本记录编写代理只改 `docs/SKILLS.md` 与本记录；技能安装由其他代理负责。用户明确授权 commit/push/PR/merge。

## 当前有效决定

- 用户明确要求安装 thesysdev/skills；Opus 核查结论为唯一技能 `openui`。
- 只做上述两处 `SKILL.md` 适配，`references/` 原样，lock 保持上游 hash。
- shadcn 适配规则（`pnpm dlx`、`-c packages/web`、worktree 相对路径、`preset decode|url|open` 不加 `-c`）继续有效，`pnpm dlx shadcn@latest info --json -c packages/web` 已实测退出 0 且路径在当前 worktree 的 `packages/web`。
- 用户已授权 commit/push/PR/merge；按授权提交并合入。

## 证据

- 现有技能可恢复快照（仓库外）：`/tmp/thesys-skills-evidence.yGzUG5/`，含 `.agents/skills`、`.claude/skills` 归档、逐文件 hash（173）、lock 副本、shadcn 适配版 `SKILL.md`、上游 `--list` 原始输出及 `SHA256SUMS`。仅在确认安装破坏既有状态时使用，不得当作上游内容。
- 上游清单原始输出同时记录了 `openui` 描述与来源 URL。
- 安装后适配副本：`/tmp/thesys-skills-evidence.yGzUG5/openui-SKILL.md.adapted`，SHA-256 `2dfdbf66712c308ac421c9bbe1957aeeac2d295bdff8c6836c2bba2f66006252`。

## 步骤

- [x] 读 `docs/DEV-WORKFLOW.md`、`docs/SKILLS.md`、`docs/PITFALLS.md`。
- [x] 记录基线，保存现有技能快照与校验信息。
- [x] 运行 `skills add thesysdev/skills --list`，取得 Opus 范围结论：仅 `openui`。
- [x] 更新 `docs/SKILLS.md`：清单新增 `openui` 行，适配章节扩为 shadcn + openui，保留 shadcn 全部规则。
- [x] 更新本记录。
- [x] 执行安装（`--skill openui --agent claude-code --agent universal -y`）并补回两处适配。
- [x] 核验：安装代理逐文件对比上游，只有 `SKILL.md` 两处适配；主会话核对原有文件、锁记录、链接、CLI 与文档清单，shadcn 命令退出 0。
- [x] 独立 Opus review 通过，无必须修改项；用户已授权 commit/push/PR/merge。

## 改动文件

- `.agents/skills/openui/`：`SKILL.md` 与 14 个参考文件。
- `.claude/skills/openui`：相对符号链接。
- `skills-lock.json`：仅新增 `openui` 条目。
- `docs/SKILLS.md`、`docs/tasks/install-thesys-skills.md`。

## 已替代项及原因

无。

## 验证

- 安装 CLI 退出 0；上游 commit 为 `bcd93adc9185e333bc9a83b29f7d81d67ab1935f`，快照位于 `/tmp/thesys-upstream-snapshot/`。
- 安装代理逐文件对比：14 个参考文件与上游完全一致；`SKILL.md` 仅 description 与 Project convention 差异。主会话复跑 `node /tmp/hashcheck/hash.js /tmp/thesys-upstream-snapshot/thesys-skills/skills/openui`：15 文件，上游目录 hash 与 CLI lock 值 `1f2f27370f1fc69ba09e96fc9186350c641d8fb0718dc8b99d131950704e7dac` 一致。
- 主会话 Node SHA-256 与备份对比：原有 173 文件、13 条 lock 与相对链接均未改变。
- `npx --yes skills@latest list --agent claude-code --json` + Node 断言：14 个项目技能的 CLI 清单、lock、目录、有效链接、维护文档一致，`openui` 对 Claude Code 可见。
- `pnpm dlx shadcn@latest info --json -c packages/web` + Node 断言：退出 0，Vite / Base UI / Tailwind v4，cwd 为当前 worktree 的 `packages/web`。
- 主会话独立 Node 字节对比：14 个参考文档与上游快照完全一致；移除 description 替换和 Project convention 段落后，`SKILL.md` 与上游完全一致。15 个安装文件均为 Markdown，内部参考链接有效，无 hooks 或脚本。
- `/usr/bin/git diff --check`：退出 0。
- 未执行业务测试、OpenUI API 调用或部署；本次没有业务代码、依赖或密钥改动。

## 下一步

验证与独立 Opus 审查已完成；用户已授权 commit/push/PR/merge，正在按授权发布。保留 worktree。

## 限制

- 未实际调用 OpenUI 服务或运行技能开发任务，未安装产品运行依赖。
- 当前上游快照未发现明确许可证声明；许可条款尚不明确。
- 安装在任务 worktree；合入前主 checkout 不包含该技能。

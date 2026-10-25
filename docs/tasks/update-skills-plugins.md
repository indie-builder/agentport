# 更新已安装技能与插件

## 目标
核对项目已安装技能及在项目生效的插件；远程有新版则更新到最新，以远程完整内容为准，同步删除上游移除的相关文件或技能。

## 方案
先盘点锁文件、技能目录/链接及插件安装范围；使用官方 Skills CLI 与 Claude Code 插件 CLI 更新。逐文件核对上游快照，保留 shadcn 已有项目适配，清除上游确实移除的内容；同步技能清单并由独立 Opus 审查。

## 基线与范围
- 起始 HEAD/main：`f6f86196cfe0b950164d52e0bc9b952ae2a72be6`。
- 初始工作树干净，无其他未提交差异。
- 项目范围：`.agents/skills/`、`.claude/skills/`、`skills-lock.json`、`docs/SKILLS.md`、本任务记录；必要时同步相关技能操作说明。
- 插件范围：本项目继承启用的 15 个 user scope 插件（interfaces、6 个语言 LSP、plugin-dev、learning-output-style、mattpocock-skills、typesafe、evoontology、ponytail、compound-engineering、pstack）。排除禁用项与其他项目专属项。用户级插件更新会影响其他项目，单独记录，不能视为 worktree 隔离。

## 当前有效决定
- 用户已明确授权更新到远程最新版，以远程为准，并删除更新涉及的相关本地旧内容。
- 用户最新澄清：保留 shadcn 的项目特有适配（`pnpm dlx`、`-c packages/web`、worktree 路径规则）；同步上游新版后仍须应用这些适配。其他内容以远程为准，上游删除项照常清理，不新增无关技能或更换项目技术栈。
- 用户已明确授权提交、创建 PR 并合并至 main；按项目规则不触发或等待 CI，不开启 PR 监控。
- 插件按原 marketplace 发布来源更新；官方文档说明同版本号可能跳过文件替换，必须核对内容，若原生命令存在限制则如实记录，不通过卸载重装丢弃插件选项/秘密/持久数据。
- 用户已明确 shadcn 项目定制必须保留；恢复原适配。本次 shadcn 上游内容无新版，因此最终该文件与任务基线相同。

## 已替代项及原因
- 先前将 shadcn 项目适配整体替换为上游原文的做法：用户澄清这是必须保留的项目特有内容，因此恢复适配，更新策略改为“上游内容更新 + 保留项目替换”。
- 初查 vercel 哈希差异的漂移判断：逐文件对比证明是官方排除 `metadata.json` 导致，未重装或修改其文件。

## 步骤
- [x] 读取研发流程与踩坑，进入干净 worktree 并记录基线。
- [x] 完成 Opus 范围探索与更新契约。
- [x] 并行执行技能、插件更新及远程完整性核对（技能目录、插件、技能文档三个范围互不重叠）。
- [x] 同步文档、运行实际验证。
- [x] 独立 Opus 审查并收尾（技能、文档、插件均通过；恢复 shadcn 适配与任务记录修正的增量复核通过）。

## 改动文件
- `.agents/skills/api-integration-surface-strategy/SKILL.md`、`.agents/skills/cli-interface-design/SKILL.md`：升级至 1.0.3。
- `.agents/skills/shadcn/SKILL.md`：恢复并保留项目适配，最终应与基线相同，不计入最终变更。
- `skills-lock.json`：两项远程哈希更新。
- `docs/SKILLS.md`、`docs/PITFALLS.md`：清单及维护说明。
- `docs/tasks/update-skills-plugins.md`：目标、取舍及验证记录。
- 技能删除清单：无。全部 13 项仍存在于上游，无已移除的技能或目录文件残留。

## 下一步
验证与独立审查已完成。按用户授权提交本任务差异、创建 PR 并合并至 main；发布结果由 PR 的提交及合并记录确认，不触发或等待 CI。

## 后续：统一维护 SOP

- 用户要求后续技能/插件更新统一沿此流程执行。
- 单一来源：扩展 `docs/SKILLS.md` 为技能与插件维护 SOP；`CLAUDE.md` 和 `docs/README.md` 仅指向该文档。精简 PITFALLS 中重复操作内容，保留现象和原因及 SOP 指针。
- 新增允许范围：`CLAUDE.md`、`docs/README.md`；其他已有技能与插件更新差异保持不动。不会新增更新脚本、定时任务或私有技能格式。
- 沿用本任务 worktree；SOP 起始已有差异为上面记录的两项技能更新、锁文件、技能清单/踩坑及任务记录，均属本任务。
- 验收：流程覆盖来源和范围、项目适配保留、上游删除、插件更新与验证/交付；入口可达，命令与已核实 CLI 一致，独立 Opus 审查通过。
- 入口已接入 `CLAUDE.md`「技能与插件维护」及 `docs/README.md`；SOP 正文覆盖维护范围、开始前比对、技能更新、shadcn 必留适配、插件更新、并发、核验与交付。PITFALLS 操作说明已去重为 SOP 指针。
- 静态检查：技能名称与来源逐项匹配锁文件、文档引用存在、项目适配/删除证据/发布 pin/未完成判据/交付授权均有明确规则；`git diff --check` 通过，shadcn 相对 HEAD 无差异。
- SOP 首轮 Opus 审查发现两项：将本次授权固化为长期授权、update 前未明确保存可恢复的适配补丁。已修正为按当次请求及既有明确授权确定范围、所有写操作前保存相对旧上游的适配补丁（无旧上游则保存整文件和规则），并注明 CLI 1.7.4 行为需按当次版本核实；独立 Opus 定向复核通过，无新增问题。
- 修正后主会话实测静态验收：清单与来源、两处入口、备份在写操作之前、全部更新后补回适配等断言通过；`git diff --check` 通过，shadcn 相对 HEAD 无差异。本次 SOP 工作未重新执行技能或插件更新，也未跑应用构建测试。

## 验证
- `/usr/bin/git rev-parse HEAD main`：两者均为上述基线。
- `/usr/bin/git status --short`：初始无输出。
- `npx --yes skills@latest --version`：`1.7.4`。
- `claude plugin update --help`：支持指定 `--scope`；需要重新加载插件使运行会话生效。
- 官方文档：<https://code.claude.com/docs/en/discover-plugins>，确认 marketplace update 仅刷新目录，需逐插件 update。
- `npx --yes skills@latest update --project --yes`：退出 0，13 项中更新 2 项（`api-integration-surface-strategy`、`cli-interface-design` 均由 1.0.2 → 1.0.3），其余 11 项上游哈希已最新，无上游整技能删除提示。
- Node 按官方 `computeSkillFolderHash` 算法比较实际目录与锁文件：初查 shadcn、vercel 有哈希差异。远程逐文件核对后，shadcn 为已知项目适配，应按用户澄清保留；vercel 是官方安装排除 `metadata.json` 导致的预期差异，75 个实际文件与远程一致，无需重装。
- Node `lstatSync` / `realpathSync`：13 个 Claude 技能入口均为符号链接，指向当前 worktree 内相应技能目录。
- `claude plugin validate .agents/skills --json`：退出 0，但 `contents: []` 表明未展开技能。随后对单个技能目录运行退出 1（缺 plugin manifest），对 `SKILL.md` 运行也退出 1（按 JSON 处理）；该插件校验入口不适用于这些独立技能。最终使用官方 Skills CLI 发现结果、逐文件上游对比及链接校验验证，不把空报告当作通过。
- `/usr/bin/git diff --check`：最终已修改文件校验退出 0，无空白格式错误；未运行应用 typecheck/build/test（仅外部技能内容、锁文件及维护文档变更）。
- `pnpm dlx shadcn@latest info --json`：退出 1，返回 `monorepo_root` 与目标 `packages/web`。证明 shadcn 需要项目级工作区适配，已按用户澄清恢复原动态命令。
- `pnpm dlx shadcn@latest info --json -c packages/web`：恢复适配后再次退出 0，返回 Vite、Tailwind v4、Base UI (`base: base`)、27 个组件及当前 worktree 内路径；技能的动态上下文使用该适配命令。
- 恢复项目适配后，主会话复跑 `node /tmp/skills-verify/verify-all.mjs`：173 个安装文件中，172 个与上游相同；仅 shadcn/SKILL.md 因用户要求的项目适配存在内容差异，`TOTAL DIFFS=1`。无本地多余或缺失文件。`git diff -- .agents/skills/shadcn/SKILL.md` 无输出，证明已完整恢复任务前适配。vercel 上游额外 `metadata.json` 按官方安装规则排除。
- Node 集合与链接断言：13 条锁记录 = 13 个技能目录 = 13 个有效 worktree 符号链接，无残留项。
- `npx --yes skills@latest list --json` + Node 断言：13 项均识别为 project scope，均对 Claude Code 可见。
- Node 文档清单断言：`docs/SKILLS.md` 与 13 个锁条目一致；全部 `SKILL.md` 含 `name` / `description` frontmatter。

### 技能远程快照

| 来源 | 核验 HEAD |
|---|---|
| addyosmani/agent-skills | `aeac41d4d005999432bb7312f7ff06383a91d59d` |
| samber/developer-platform-skills | `436d806c08ec011d20ed9d15a53cb6ee619701c4` |
| anthropics/skills | `dbd4588f9e1033efb41dad4bef2f7947c8993d44` |
| shadcn-ui/ui | `617134d5810bba521803b3ed787190bacbb80b35` |
| supabase/agent-skills | `c9be0e931b7930f7d02126d04774d904c381e7d7` |
| wshobson/agents | `0874a27b17a22e2b7c2e2bcd725768e0803cad06` |
| obra/superpowers | `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b` |
| vercel-labs/agent-skills | `063bee94c3f4df8453406c830b0a7df0f2860278` |

详细临时证据：`/tmp/skills-verify/evidence.txt`；此路径仅供本次复核，持久结论与快照标识记录在本文件。

### 安装入口实测

仅传 `--agent claude-code` 的定向重装曾转为 copy 模式，只替换 `.claude/skills/shadcn`，未更新 `.agents/skills/shadcn`。追加 `--agent universal` 后 canonical 目录与 Claude 相对链接均正确恢复。最终无 `.claude/skills/` 差异；维护命令相应补齐两个 agent 参数。

### 审查

- 文档第一轮 Opus 审查通过；随后根据安装入口实测补齐定向重装命令的 `universal` 参数，独立 Opus 定向复核同样通过。
- 技能内容及锁文件：恢复项目适配前的独立 Opus 审查通过（逐文件 0 差异、8 个来源远程 HEAD 一致）；用户澄清后恢复 shadcn 适配。增量 Opus 确认技能与维护说明通过，发现任务记录旧结论与历史验证标记需修正，已修改并定向复核。
- 插件：独立 Opus 审查通过，重新计算 15 个缓存与来源的文件哈希，无来源文件缺失、无内容差异、无应删除的活动组件。审查指出临时 SUMMARY 中“远程 refs 全等于安装 SHA”表述过宽：安装登记 SHA 可较旧，但当前组件内容相同；另官方市场刷新缺单独命令日志，已由内容核验与刷新时间佐证。

### 插件结果

- 通过官方 CLI 刷新 7 个相关 marketplace（interfaces、typesafe-ai、evoontology、ponytail、compound-engineering-plugin、cursor-plugins、claude-plugins-official），再依次运行 `claude plugin update <id> --scope user --json`。
- 15/15 均 `outcome: ok`、`updateOutcome: up_to_date`，无失败、无版本变化；主会话重新解析 15 份 JSON 并断言当前安装登记与 before/after 字节一致。
- 缓存逐文件对照对应最新发布来源一致。evoontology 的 23 个额外文件仅为运行生成的 Python bytecode；不属于过期技能，不删除运行缓存或持久数据。
- 仅 7 个 marketplace 的刷新时间改变；安装登记、插件启用状态、scope、配置与数据均未改变。
- 无上游已删除的活动技能、命令或子代理，无需删除。

| 插件 | 检查后版本（与检查前相同） |
|---|---|
| interfaces | 1.16.0 |
| typescript-lsp、pyright-lsp、swift-lsp、gopls-lsp、rust-analyzer-lsp、kotlin-lsp | 各 1.0.0 |
| plugin-dev | ad30d62cd52a-04b3e1d6 |
| learning-output-style | 1.0.0-58267944f921 |
| mattpocock-skills | 1.3.1 |
| typesafe | 0.6.2 |
| evoontology | 1.1.1 |
| ponytail | 5.3.2 |
| compound-engineering | 3.32.1 |
| pstack | 0.15.32 |

发布来源说明：
- mattpocock 的官方 marketplace 固定 `49dd158d1076134a641b33efb035946536778336`（1.3.1）；源仓库 HEAD `5beb35b` 多一个提交，仅修改 changeset 与 manifest 未启用的 `in-progress/chief-of-staff`。保持原官方发布 pin，27 个启用技能未变。
- plugin-dev 旧缓存 SHA 与官方目录 reviewed commit 不同，但 `plugins/plugin-dev` 子树一致，不存在文件内容漏同步；保持原 `@anthropic-plugin-directory` ID。

临时证据：`/tmp/plugin-update-20261025-121833/SUMMARY.txt`、逐插件 `update-*.json`、各 `compare-*.txt`、`remote-heads.txt`。插件内容未变，无需为本次结果重新加载；用户级目录刷新可被其他项目看到。

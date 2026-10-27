# 更新用户级 Claude Code 插件与项目 Skills

## 目标

将用户级已安装 Claude Code 插件更新到各自现有 marketplace 发布的最新版本；检查并更新项目 Skills，保留已登记的项目适配，逐文件核验。

## 方案

先由 Opus 只读探索技能更新契约，再由 Sonnet 执行更新；用户插件和项目 Skills 互不写同一注册表，可并行。各任务内 marketplace / 插件注册表写入、skills-lock.json 写入分别串行。完成后由独立 Opus 审查。

## 基线与范围

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/update-plugins-skills`
- 分支：`worktree-update-plugins-skills`
- 起点：`9b8bebdd44286510ba93d9f966228d778323bcd8`，已 fetch 并与 `origin/main` 一致。
- 工作树初始无未提交差异；主 checkout 原有 `.vitest/json/output.json` 修改归属既有工作，不触碰。
- 用户插件：只修改 user scope 的已安装插件缓存和注册表，保留来源、发布 pin、启用状态与持久数据。
- 项目 Skills：`.agents/skills/`、`.claude/skills/`、`skills-lock.json`、必要的维护文档与本任务记录。
- 不更改业务源码、项目依赖，不启动服务。

## 当前有效决定

- 用户明确要求更新用户维度已安装插件，并检查更新项目 Skills。
- 本次覆盖用户级已安装的禁用插件；覆盖 `docs/SKILLS.md` 的默认禁用项排除范围，保持其禁用状态。
- 保留所有已登记项目适配；更新前保存完整备份与差异证据。
- 用户未授权 commit/push/merge，以已验证的未提交工作树差异交付，用户插件直接在用户环境生效（需重载）。

## 已替代项及原因

无。

## 步骤

- [x] 阅读技能维护 SOP、研发流程与踩坑记录。
- [x] 核对 Claude Code 官方插件安装与加载文档、本机 CLI 帮助。
- [x] fetch 并建立独立工作树、记录基线。
- [x] Opus 完成技能更新契约探索：25 项技能 / 16 来源仓库，11 项技能 / 13 文件包含适配，保留完整备份后更新并三方核验。
- [x] 用户级插件备份、更新与发布来源核验：22/22 outcome ok，4 updated、18 up_to_date；主会话直接重算当前 3212 个文件哈希一致。
- [x] 项目 Skills 备份、更新、补回适配与完整目录核验：3 更新、22 已最新、0 删除；主会话复跑完整核验 RESULT PASS。
- [x] 独立 Opus 审查及按范围验证：首轮实物通过，交付记录问题修正后定向复核明确通过。
- [x] 更新记录并交付未提交结果，保留 worktree；未提交、未推送、未合入 main。

## 改动文件

当前已观察到的更新（最终以执行报告与审查为准）：

- 用户插件：`claude-hud 0.13.0 → 0.13.1`、`compound-engineering 3.32.1 → 3.33.1`、`interfaces 1.16.0 → 1.17.0`、`pstack 0.15.32 → 0.15.34`。
- 项目 Skills：`api-error-design 1.0.1 → 1.0.2`、`api-integration-surface-strategy 1.0.3 → 1.0.4`、`public-api-design-review 1.0.2 → 1.0.3`。
- 当前 Skills diff 包括 5 个上游技能文件和 `skills-lock.json`，已由主会话读取差异。

最终项目改动为 5 个上游技能文件、`skills-lock.json`、`docs/SKILLS.md` 和 3 份本次任务记录。

文档与实际行为冲突点：原维护文档没有明确上游 `metadata.json` 参与 lock hash、却被安装排除的情况，已补正；不据此回填 lock 或重装技能。其余来源与项目适配规则一致。

## 下一步

更新、主会话独立验证与 Opus 定向复核均已通过，无剩余阻断问题。以本 worktree 未提交差异交付；未提交、未推送、未合并，因此保留工作树。用户级插件磁盘版本已更新，当前会话尚未重载，可执行 `/reload-plugins` 或开启新会话。

Skills 结果记录在 `docs/tasks/update-project-skills-result.md`，插件结果记录在 `docs/tasks/update-user-plugins-result.md`。最终审查范围为 5 个技能文件、`skills-lock.json`、`docs/SKILLS.md`、3 份任务记录，以及用户插件更新证据：

- 用户插件：仅 user scope 发生更新，来源 / pin / 启用状态保留；未执行主动删除持久数据的操作，但没有更新前持久数据清单，不能证明前后逐文件一致。directory binding 仅有 after 快照，不宣称独立验证其前后一致。全部更新有 outcome，缓存与发布内容一致，活动组件存在。
- Skills：lock、目录、链接和 CLI / 文档清单一致；上游 hash 与实际源快照对应；无项目适配之外的差异；shadcn 实物命令通过且路径在当前工作树。
- 交付：记录所有未完成项与文档冲突，不把缓存漂移或网络失败报告成最新；不提交、不推送、不合并。

## 验证

- `claude --version`：`2.1.311`。
- `claude plugin list --json`：已取得当前安装清单及 scope，更新执行前由插件代理保存备份。
- `claude plugin update --help`：支持 `--scope user --json`。
- `claude plugin marketplace update --help`：支持具名 marketplace 刷新与 `--json`。
- `npx --yes skills@latest --version`：`1.7.4`。
- `npx --yes skills@latest --help`：支持项目更新、指定 skill 更新、canonical 与 Claude Code 双 agent 安装；存在 npm 对项目 `strict-peer-dependencies` 配置的警告，退出成功。
- 官方依据：<https://code.claude.com/docs/en/plugins/install.md>、<https://code.claude.com/docs/en/plugins/loading.md>。CLI marketplace update 只刷新目录；同计算版本不替换缓存；更新后需 `/reload-plugins` 或新会话。
- 新建工作树未安装 `node_modules`，本地 SDK 类型定义不存在；本任务不涉及 SDK API 变更，插件行为已核对官方文档及已安装 CLI 帮助，不为查类型安装业务依赖。
- `git diff --check`：当前差异格式检查退出 0（技能更新前）。
- `claude plugin validate .agents/skills --json`：退出 0、`success: true`，但 `contents: []`，没有实际文件覆盖，不能作为技能格式验证通过的证据；完成验收仍以完整目录与适配核验为准。
- 主会话独立 Node assert 校验：25 项 lock 记录、`.agents/skills` 实体目录、`.claude/skills` 链接集合完全一致；全部为 `../../.agents/skills/<name>` 相对链接，实路径指向本 worktree，每项 `SKILL.md` 非空，PASS。
- 主会话最终 `npx --yes skills@latest list --json` 配合断言：25 项与 lock 清单一致，全部 project scope、Claude Code 可见、路径位于本 worktree，PASS。
- 更新后的 `git diff --check -- .agents/skills .claude/skills skills-lock.json docs/SKILLS.md`：退出 0。
- 更新后的 `public-api-design-review/evals/evals.json`：JSON 解析成功。
- 主会话实测 `pnpm dlx shadcn@latest info --json -c packages/web`：退出 0，返回 Vite / Tailwind v4 / Base UI，`resolvedPaths.cwd` 为当前 worktree 的 `packages/web`，适配实物验证通过；无需安装业务依赖。
- 主会话重新从当前插件缓存与发布快照读取文件并计算 SHA-256（非复用缓存清单）：22 项、3212 个文件一致，当前安装注册版本与备份的 after 清单一致，启用状态与 before 清单一致。
- 主会话复跑 `node /tmp/skills-update-verify.xyL1xo/verify-final.mjs`：25 项逐文件核验 `RESULT PASS`；13 个适配文件均为已登记差异，3 项更新与新上游一致，未发现缺失或多余文件。
- 用户插件备份：`/tmp/claude-user-plugins-backup.ArZv0I/`；Skills 备份：`/tmp/skills-update-backup.Ekzo4a/`。临时目录可能被系统清理，持久结论见两份结果记录。
- 未保存持久数据的更新前完整清单；directory binding 仅有更新后快照。执行中未主动删除或改绑，当前未发现丢失，但不宣称已经独立验证这两项前后一致。
- 首轮 Opus：更新实物核验通过；交付记录需补齐 `/reload-plugins`、收窄持久数据 / directory binding 的证据表述、把 `docs/SKILLS.md` 纳入最终审查范围。三项均已修正，后续定向 Opus 复核明确通过，无剩余阻断问题。
- 本次只更新外部技能、锁文件与维护记录，未运行应用 typecheck / build / 业务测试，未运行付费模型或插件运行期功能测试。
- 主会话独立使用 CLI 目录 hash 算法重算 25 项实际上游目录（包含 `metadata.json`）：全部与最终 `skills-lock.json` 的 `computedHash` 一致。
- 主会话重新解析 22 条 plugin update JSON：全部 exit 0、`outcome: ok`、scope user，18 `up_to_date` / 4 `updated`。
- 主会话复跑插件范围和活动组件检查：7 条 project scope 记录未变，4 个升级插件的旧缓存均在，组件检查 `ISSUES: 0`；LSP PATH 缺口单列如下。
- 主会话直接比对原始注册 JSON：所有 marketplace `source` 保持一致；7 条 project scope 安装记录逐字段一致（不是仅比版本与路径）。
- 原有环境限制：gopls、kotlin-lsp、pyright-langserver、typescript-language-server 不在 PATH；相关插件已更新核验，但无法据此宣称对应 LSP 服务能启动，本次未安装环境工具。

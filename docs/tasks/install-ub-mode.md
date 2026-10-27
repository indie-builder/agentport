# 安装 ub-mode 技能并落地为默认工程纪律

## 目标

- 原样安装上游 <https://github.com/unclebob/ub-mode> 的 `ub-mode` 技能到 `.agents/skills/ub-mode/`，
  登记 `skills-lock.json`，建立 `.claude/skills/ub-mode` 相对链接。
- `.agents/skills/ub-mode/SKILL.md`、`README.md` 与上游逐字节一致，不做任何本地适配；原有技能全部保持不变。
- 把 `ub-mode` 定为本项目默认日常工程纪律，并落地到 `CLAUDE.md`、`docs/DEV-WORKFLOW.md`、`docs/SKILLS.md`。
- 本轮不安装配套工具、不改 `settings.json` / hooks；按用户最新授权执行 commit、push、创建 PR 并合并 main（见「当前有效决定」）。

## 基线与范围

- 工作目录：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/install-ub-mode`，
  分支 `worktree-install-ub-mode`；基线 commit `4979e235d8fad97ecb45d468e05a1e7922a85e63`，
  等于 `git fetch origin main` 后的 `origin/main`；起始 `git status` 为空。
- 环境：skills CLI 1.7.4，Claude Code 2.1.311。官方
  <https://code.claude.com/docs/en/skills.md> 确认 `.claude/skills` 符号链接与热加载；当前会话
  技能列表已出现 `ub-mode`。
- 改动面：技能安装（`.agents/skills/ub-mode/`、`.claude/skills/ub-mode`、`skills-lock.json`）与三份文档
  （`CLAUDE.md`、`docs/DEV-WORKFLOW.md`、`docs/SKILLS.md`），加上本记录。

## 当前有效决定

- 用户最新明确「提交PR，然后合并」（2026-10-28）：已授权 commit、push、创建 PR、合并到 main；
  按项目规则不触发、不等待 CI，不监控 PR。此授权晚于此前「不 commit」状态，两者按时间区分：
  授权前未提交是当时的实际状态，不视为当前仍有效的限制。截至本记录更新时，PR 与合并均未执行、
  未创建，不预填 PR 号或 commit hash。
- 本轮（2026-10-28）仅更新本记录，未新增实现改动。
- 用户授权「按你的建议来给我调整一下」（2026-10-28）：`ub-mode` 作为默认日常工程纪律；
  pstack 保留模型 / 任务 / 并行 / 独立 review 编排；`test-driven-development` 按需提供红绿步骤参考；
  `verification-before-completion` 负责交付验证；日志用已有任务记录（`docs/tasks/<slug>.md`）。
- 阶段名称照上游英文：First Make it Work → Then Make it Right → Follow Practice。需要中文时说
  「先实现目标功能 → 再完善设计与实现 → 遵循工作纪律」；不再使用「先跑通 / 再改对 / 守住实践」这一译法。
- 原版 `ub-mode` 与其余技能保持不变，不装配套工具、不改 `settings.json` / hooks；提交、PR 与合并按用户最新授权执行。
- 流程权威指向 `docs/DEV-WORKFLOW.md`；`docs/SKILLS.md` 只写职责分工，不复制整套规则。
- 全文不重复同一套纪律条款：`CLAUDE.md` 写摘要与冲突裁决，`docs/DEV-WORKFLOW.md` 写流程细节，
  `docs/SKILLS.md` 只写入口与分工。

## 已替代项及原因

- 旧记录「用户尚未要求更改 `CLAUDE.md` / `docs/DEV-WORKFLOW.md`，本次未作这些更改」已失效：
  这两份文件已在最新授权下完成修改，记录按实际改动更新。
- 旧记录按「本执行者 / 另一个执行者」切分范围的做法取消；本任务作为一个整体记录，不再叙述内部分工。
- 旧记录「未提交、未合入 main，未经用户授权不 commit / push / merge」是授权前的实际状态；
  用户已授权提交、PR 与合并后该限制失效，记录按实际执行更新。
- 旧结论「保留 pstack 负责编排」仍有效，并已补充 `ub-mode` 成为默认纪律。

## 步骤

- [x] 原样安装 `ub-mode`，登记 lock，建立相对链接；保留安装前基线证据。
- [x] 在 `docs/SKILLS.md` 写清 `ub-mode` / pstack / TDD / 交付验证的分工，清单与入口同步，流程权威指向 `docs/DEV-WORKFLOW.md`。
- [x] 在 `CLAUDE.md` 写工程纪律入口与项目约束优先级；在 `docs/DEV-WORKFLOW.md` 写实现、验证与任务记录细则。
- [x] 第一次独立 review 指出需修三阶段释义、任务整体事实与重复条款；修正后独立 Opus 复核通过：
  「三阶段释义、任务整体事实与重复条款均已修正，未发现修正引入的新冲突。第一阶段测试要求与
  诚实测试例外一致，无需追加修改。」

## 安装事实

- 安装命令（worktree 根，项目 scope）：

  ```
  npx --yes skills@latest add https://github.com/unclebob/ub-mode --skill ub-mode \
    --agent claude-code --agent universal -y
  ```

- 上游快照：新空目录克隆于 `/tmp/install-ub-mode-upstream-clone/repo`，commit
  `57a8bdd28e45ed41900ace0bafa2ff76dd9ed70f`（2026-10-25）。
- 证据目录：`/tmp/install-ub-mode-evidence/`（安装前 lock `skills-lock.baseline.json`、
  `.agents/skills` 全量校验和前后快照、shadcn/openui 适配副本）。

## 改动文件

- 新增 `.agents/skills/ub-mode/SKILL.md`（3958 B，sha256 `4120873d…f3202`，与上游一致）
- 新增 `.agents/skills/ub-mode/README.md`（2195 B，sha256 `1c8e5690…a6bd9`，与上游一致）
- 新增 `.claude/skills/ub-mode` → `../../.agents/skills/ub-mode`
- 修改 `skills-lock.json`：只新增一条

  ```json
  "ub-mode": {
    "source": "unclebob/ub-mode",
    "sourceType": "github",
    "skillPath": "SKILL.md",
    "computedHash": "e2e28ad6f12ce3bc1e5be6676b0dcd88c217957c79c512b418c241fa2e5825a0"
  }
  ```

- 修改 `docs/SKILLS.md`：清单加入 `ub-mode` 来源与阶段名称；新增原样安装小节与职责分工；
  `test-driven-development`、`verification-before-completion` 的用途同步为分工后的短说明。
- 修改 `CLAUDE.md`（协作方式）：`ub-mode` 为默认工程纪律、与 pstack / TDD 的冲突裁决，
  以及项目专属约束优先于通用技能。
- 修改 `docs/DEV-WORKFLOW.md`：实现阶段写入 ub 三阶段、并行单元与诚实先红后绿；验证阶段写明
  按范围完整跑、可复用证据且如实报告；任务记录模板补动作理由与验证证据，门禁策略补配套工具按需试用。
- 本记录。未改其他技能、用户级安装、`settings.json`、hooks。

上游只有这两个文件，无脚本、无 hooks、无 `metadata.json`；`computedHash` 为 CLI 计算的上游
目录 hash，保留上游值。README 说明技能定位及 crapper / dryer / mutator / uml-viewer 四个配套
工具，本次未安装这些工具。

## 验证

主会话实测（2026-10-28）：

- lock 条目、`.agents/skills` 目录、`.claude/skills` 相对链接均为 26 项且一一对应，链接指向当前 worktree；
  `docs/SKILLS.md` 清单同为 26 条。
- `ub-mode` 两个文件与上游快照 `diff -r --exclude=.git` exit 0；既有 362 个技能文件 sha256 与装前一致。
- `CLAUDE.md`、`docs/DEV-WORKFLOW.md`、`docs/SKILLS.md` 中本地相对链接全部可解析。
- `git diff --check` 退出 0。
- 本会话已实际调用 `ub-mode` 并成功加载；未来会话默认加载行为未单独实测。
- 纯文档改动，无需产品测试；crapper / dryer / mutator / uml-viewer 未安装也未运行。
- 上述验证完成时（授权前）未提交、未合入 main；此后用户已授权提交、PR 与合并，执行状态见「下一步」。

## 上游事实

- 仓库无 LICENSE / COPYING 文件，只有 `SKILL.md` 与 `README.md`。此处仅登记事实，不做许可结论；
  安装已获用户授权。

## 流程评估结论（独立 Opus，安装阶段）

建议采用原版核心工程纪律：最小完整改动、数据形状先行、诚实 TDD（先失败再实现）、修根因、
测行为而非实现、可验证的小步重构。保留 pstack 负责编排；独立单元可并行，单元内部小步验证；
现有任务记录（本文件）即承担日志职责，无需另建流水账。

配套工具按范围试验，不作为常驻门禁、不固定版本，也不以“发布年轻”作为永久不用的理由：

- [crapper](https://github.com/unclebob/crapper)：支持 TS/TSX、LCOV、Vitest；可能自动 npm 安装
  coverage provider，且覆盖率失败时按 0 继续。
- [dryer](https://github.com/unclebob/dryer)：支持 TS/TSX；默认可配置阈值 0.82，而技能写明 0.8，
  候选重复需人工判断业务语义。
- [mutator](https://github.com/unclebob/mutator)：可定制 Vitest；需相邻 crapper 与显式根测试命令，
  反复运行成本较高。

以上仅为静态核对结论，本轮未安装、未实跑，也未新增工具研究或未查证的命令。若后续在具体范围试用，
按“先 dryer 单模块，再 crapper 消费现有 LCOV，最后 mutator 用于纯函数”的顺序，用一次再定是否保留。

## 下一步

1. 实现与验证已完成，独立 Opus 复核通过结论保持。
2. 按用户授权执行：提交改动 → push 分支 → 创建 PR → 合并到 main；按项目规则不触发、不等待 CI，不监控 PR。
3. 合并后按 `docs/DEV-WORKFLOW.md` §2-7 清理已合入的 worktree（分支与远程保留）；无未提交内容时才删除。
4. 后续按需建议：配套工具未装、未实跑，是否在某范围试用由用户后续决定，不计入本次未完成项。

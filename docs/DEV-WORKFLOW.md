# 研发流程规范

> 本文件是**执行流程**的唯一来源；`CLAUDE.md` 只放指针和最高优先级约束。所有任务统一按本流程执行。
> 个人项目取向：**不加阻塞式门禁**（不装 pre-commit 跑 typecheck/test），校验落在 review 与异步 CI，保证本地快速迭代。

## 1. 文档体系（单一真相，不建副本）

「每个关切一个权威文件」，缺什么先看现有，不并排再造：

| 关切 | 权威文件 | 谁读 |
|---|---|---|
| 要建什么、为谁 | `PRODUCT.md` + `docs/PROJECT-BRIEF.md` + `docs/USER-STORIES.md` | 需求澄清时 |
| 技术栈、目录、数据流 | `docs/ARCHITECTURE.md` | 设计时 |
| 颜色、字体、组件、氛围 | `docs/DESIGN-SYSTEM.md` | 做 UI 时 |
| 编码规则与 AI 禁止事项 | `CLAUDE.md` | 每会话自动加载 |
| 项目级待办 | `docs/REMAINING-TODOS.md` | 规划时 |
| 变更历史 | `CHANGELOG.md` | 追溯时 |
| **单个任务的记录** | `docs/tasks/<slug>.md` | 任务期间/追溯 |
| **跨任务踩坑汇总** | `docs/PITFALLS.md` | 开工前、报错时 |

> 参照的「6 文件法」（PRD/ARCHITECTURE/DESIGN/RULES/TASKS/PROGRESS）解决的是从零起项目的「无据可依」；本项目已有上述分层文档，**不再新建 6 个根文件**。只采用它唯一值得补的一层：任务级记录（对应 PROGRESS，带「下一步」以便断点续传）。

> `docs/REMAINING-TODOS.md` 是**项目级待办的唯一来源**；`docs/tasks/<slug>.md` 只记录**正在执行**的单个任务的细节，两者不重复登记。

## 2. 任务生命周期

1. **需求澄清（主 checkout，不隔离）**
   在项目根目录讨论：目标、边界、涉及文件、验收方式。此阶段不建 worktree、不改代码。
   **完成判据**：用户明确确认「按这个做」。

2. **建隔离环境**
   方案定了、要动文件时，`EnterWorktree` 建一个以任务命名的 worktree（名字用 ASCII slug，如 `log-to-file`；工具不接受中文名）。
   **完成判据**：会话已位于 `.claude/worktrees/<name>`，主 checkout 不再收到该任务的文件。

3. **先写任务记录**
   在 worktree 内创建 `docs/tasks/<slug>.md`（模板见 §3），先把目标与方案写下来再动手。
   **完成判据**：记录文件存在且含目标、方案、步骤。

4. **实现（子代理并行）**
   按 `CLAUDE.md` 协作方式：Opus 定契约，Sonnet 子代理并行落地，主会话只编排。所有产出只写进 worktree。
   **完成判据**：契约固定、子代理产出在各自边界内、主 checkout `git status` 无该任务文件。

5. **Review**
   Opus 子代理做 code review（正确性/安全/死代码/契约一致性）；纯机械规则可直接跑 `pnpm lint:focus`、`pnpm exec biome check`（按需、秒级、不阻塞）。
   **完成判据**：review 通过，或问题已修复。

6. **验证与收尾**
   跑受影响范围的真实校验（typecheck/test/build 按改动面选）；更新任务记录（下一步、验证结果）；提交到任务分支并合入。
   **完成判据**：验证命令有真实输出、记录已更新、已提交。

7. **`ExitWorktree`**
   有改动就 keep（保留分支），确认收尾后按需移除。

## 3. 任务记录模板

`docs/tasks/<slug>.md`：

```markdown
# <任务名>

## 目标
<要解决什么、验收标准>

## 方案
<所选做法与关键取舍>

## 步骤
- [ ] ...

## 改动文件
- ...

## 下一步
<未完成项 / 需用户决策项；做完写「无」>

## 验证
<命令 + 真实结果>
```

> 踩坑不写进任务记录，写进 `docs/PITFALLS.md` 并在记录里引用（§4）。

## 4. 踩坑流程

- 遇到跨任务可能复现的坑，在 `docs/PITFALLS.md` 追加一条：**现象 → 原因 → 规避**。
- 只写代码和文档里看不出来的东西。
- 开工前或遇到报错先读该文件。

## 5. 门禁策略（个人项目）

- **不加 blocking 钩子**：不装 pre-commit 跑 typecheck/build/test。
- **CI 异步**：`ci.yml` 仅在 push/PR 触发，不占本地编辑时间；保持现状即可，不再往里堆 job。
- **机械检查按需跑**：`lint:focus`、`lint:contract`、`biome check` 这类秒级脚本交给 review 阶段顺手执行。
- **判断类标准**交给 Opus review 代理（跨文件一致性、符合周边风格、契约取舍），不写进常驻上下文。

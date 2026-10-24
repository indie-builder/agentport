# 文档剪枝与单一真相收敛

## 目标
按 writing-for-agents 的上下文指针 / 单一真相 / 环境缓存三原则，修掉文档里的陈旧点、
打破「待办来源唯一」的叠层，并给本次改动留 CHANGELOG 记录。不改变任何代码行为。

## 方案
- P0 陈旧/缓存：删 `docs/README.md` 关于 tasks 目录「目前无任务时为空」的过期描述；
  `CLAUDE.md` 的 E2E 行去掉 `e2e@0.21.2` 版本号（版本属环境，`package.json` 可查）。
- P1 单一真相：在 `CAPABILITY-GAP.md`、`HANDOFF.md` 顶部各加一行「只读历史，未完成项见 REMAINING-TODOS」，
  不再让它们充当第二/第三待办源。
- 本次改动补一条 `CHANGELOG.md` 条目（0.13.1）。

## 步骤
- [x] 改 docs/README.md
- [x] 改 CLAUDE.md E2E 行
- [x] 给 CAPABILITY-GAP / HANDOFF 加历史横幅
- [x] 补 CHANGELOG

## 改动文件
- `docs/README.md`
- `CLAUDE.md`
- `docs/CAPABILITY-GAP.md`
- `docs/HANDOFF.md`
- `CHANGELOG.md`

## 下一步
- 待用户判断：DECISIONS-PENDING 的已决策项是否归档、规划类文档是否合并去重（本次未做）。

## 验证
- 人工核对改动行。

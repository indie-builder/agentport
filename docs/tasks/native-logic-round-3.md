# 手写逻辑简化：第三轮

## 目标

复用现有技术栈与原生能力，删除手写辅助逻辑，保持视觉、交互和业务规则。用户授权实施、提交 PR 并合并，合入后删除任务 worktree、更新 main。

## 方案

Opus 并行探索前后端，Sonnet 按文件域执行，独立 Opus 评审，主会话审查和运行验证后提交合并。源码与测试全部由执行子代理修改，主会话只维护记录和交付。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/native-logic-round-3`
- 分支：`refactor/native-logic-round-3`
- 起始 origin/main：`7d0cf6040d0031138c4922e8dabdd64eae856e6c`
- 初始未提交差异：空。
- 文件：`packages/web/src/components/app-shell.tsx`、`packages/core/src/openui-response.ts`、本记录。
- 其他任务 `skill-provenance` 工作区不修改、不清理。

## 当前有效决定

- 用户已授权 commit/push/PR/merge、删除已合并工作区、更新 main；无需再次确认。
- 子代理“不再派发、不自行提交”是执行分工，不能解释为用户撤回授权。早期执行者记录中的相反表述已纠正。
- 独立评审通过才提交；不触发、不等待 CI，不启动 PR 监控。
- 不改共享服务、配置、数据库和登录态。
- 保留 PR #48 与 #50；不实施已否决的引用弹窗查询迁移。

## 实现与取舍

### A：侧栏 Motion 直接使用 CSS 变量

删除 `sidebarMetrics()` 的 `getComputedStyle` 读取、padding 解析、重复兜底及 `useMemo` 缓存。动画目标改用现有宽度与内边距变量，保留 `initial={false}`、160ms、`[0.22, 1, 0.36, 1]`、减少动态效果、移动抽屉和焦点逻辑；styles token 不变。文件 +3/-44，净删 41 行。

官方 https://motion.dev/docs/react-animation 与本地 Motion/motion-dom 14.6.0 的 DOMKeyframesResolver、getVariableValue 和 complex mixer 支持变量目标及复合字符串插值。现有测试无需变更；真实浏览器验证动画和几何，不新增实现镜像测试。

### B：原生字符串裁剪

`joinParts()` 两行首尾空白正则改为 `trimStart()` / `trimEnd()`。ECMAScript TrimString 与 `\\s` 使用同样的 WhiteSpace 和 LineTerminator 集合；纯空白段过滤、零段/单段、首段开头和末段结尾保留、两换行连接规则不变。core 调用和 worker 消息持久化不改。

## 已替代项及原因

侧栏手写 token 读取原因为“Motion 读不到 var()”，但官方文档及安装版本均支持该能力；重复缓存还无法反映运行时 token 更新。本轮删除该实现与两处错误注释。

## 浏览器验收

真实 AppShell + styles + QueryClient + memory router，预置认证查询以避免 API 请求；独立临时 Vite `http://127.0.0.1:54637/`，配置与 harness 位于本树 `.tmp/sidebar-harness`。源代码基线为本轮起始 commit，随后恢复最终实现。

同一 harness 修改前后通过 getBoundingClientRect/getComputedStyle 对照：

| 场景 | 修改前 | 修改后 |
|---|---|---|
| 展开 | 272px，padding 16/12/16/12 | 相同，终态保留 var 引用 |
| 收起 | 68px，padding 16/18/16/18 | 相同，终态保留 var 引用 |
| 收起中间态 | 93.273 → 79.641 → … → 68 | 94.406 → 87.359 → … → 68 |
| 展开中收回 | 间隔 90ms，终态 68 | 间隔 91ms，终态 68，有插值 |
| 收起中展开 | 间隔 96ms，终态 272 | 间隔 99ms，终态 272，有插值 |
| reduced motion | 直接到 68，无中间态 | 相同 |
| 375px 移动抽屉 | content 294px，aside 293px；关闭焦点回打开导航 | 相同 |
| 修改宽度 token 为 300 px | 缓存值仍为 272 | 读取 300，移除后恢复 272 |

浏览器需 screencast 驱动持续出帧才能采样中间态；采样起点有差异，不作为逐帧性能对比。移动 content/aside 的 1px 差来自 Sheet 右边框。临时 Vite 与 `native-round3-sidebar` 浏览器空间均已关闭，临时工具不提交。

## 验证与评审

- 锁定依赖安装、shared/core/db 构建通过。
- 主会话复验 `pnpm test:web`：73 文件 711 项通过，0 跳过；有既有 jsdom 页面跳转未实现提示。
- 主会话复验 core openui-response：12/12 通过；core typecheck 通过。
- 执行者 web typecheck/build、shell-route 8/8、Biome、diff --check 通过。
- B 独立 Opus 评审通过：12 项测试，1,114,112 个 Unicode 码点及 22,621 组新旧输出对照通过。
- 主会话最终 7 包 typecheck、focus/contract、两文件 Biome、core/web build 与 diff --check 通过；构建有既有 chunk 体积提示。
- A 独立 Opus 评审通过：shell-route 8/8；实际 resolver 与 padding 插值断言通过，保留 160ms、初始态、反向与移动抽屉行为，无阻断项。
- 未跑真实登录/API、完整产品 E2E 或数据库持久化测试；本轮不改变这些路径，不宣称量化提速。

## 冲突

已修正上述两处“Motion 读不到 CSS 变量”的源码注释；未发现其他涉及的产品文档与代码冲突。

## 步骤

- [x] 同步 origin/main 并建树，固定范围
- [x] Sonnet 并行实现 A/B
- [x] 浏览器验收与范围测试
- [x] B 独立评审
- [x] A 独立评审
- [ ] 提交、PR、合并
- [ ] 删除本树、更新 main

## 改动文件

- `packages/web/src/components/app-shell.tsx`
- `packages/core/src/openui-response.ts`
- `docs/tasks/native-logic-round-3.md`

## 下一步

A/B 实现、范围验证与独立评审均通过。按用户授权完成提交合并与清理；实际合并和清理结果以 GitHub/Git 状态为准。

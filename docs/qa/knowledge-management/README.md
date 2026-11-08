# 知识库管理（概览 / 编辑信息 / 复制）浏览器验收

- 日期：2026-11-08
- 分支：`knowledge-mgmt`（PR #228）
- 环境：独立验证库 `agentport_kb_ui_verify`（`docker` 内 postgres，迁移后由 API 首次启动建管理员），分支 API `:3100`，Vite dev `:5273`（`/api` 代理到 3100），Chrome headless，1440×900、DPR 2、`zh-CN`
- 账号：本地 `.env` 的 `ADMIN_USER` / `ADMIN_PASSWORD`；未改动任何既有账号或主开发库

## 数据准备（真实接口，非 mock）

同一套 API 依次创建：1 个 embedding profile、1 个知识库（`handbook`，含描述与分块/Wiki 设置）、2 篇手写文档、1 个文件夹、2 个标签、1 个 Wiki 页；随后由概览页读取真实统计。

## 断言与结果

| 检查 | 结果 |
|---|---|
| 列表行菜单含「编辑信息 / 复制知识库 / 设置 / 停用 / 导出知识包 / 删除」 | 通过（`02-row-menu.png`） |
| 「编辑信息」预填当前名称与描述，保存后列表立即显示新描述 | 通过（`03-edit-dialog.png`） |
| 「复制知识库」预填「产品手册 副本」、slug 留空并显示建议值 `handbook-copy` | 通过（`04-duplicate-dialog.png`） |
| 复制后进入新库，新库计数全 0、描述与配置沿用源库 | 通过（`06-copy-overview.png`） |
| 详情页页签为「概览 / 文档 / 来源 / 检索测试 / 离线评估 / FAQ / Wiki / 处理记录」，默认文档 | 通过 |
| 概览计数与 `/summary` 一致：文档 2、FAQ 0、Wiki 1、来源 0、文件夹 1、标签 2 | 通过（`05-overview.png`） |
| 概览显示完整描述、配置摘要（模型名解析）、最近任务与处理记录入口 | 通过 |
| 「复制知识库」按钮与「配置」标题同行右侧；专家空态左对齐无空洞 | 通过（几何断言：同一行、左右边界差 < 2px） |
| 1280px 宽无横向溢出 | 通过 |
| 浏览器控制台无 error / pageerror | 通过 |

## 截图

| 文件 | 内容 |
|---|---|
| `screens/01-list.png` | 知识库列表 |
| `screens/02-row-menu.png` | 行操作菜单 |
| `screens/03-edit-dialog.png` | 编辑信息弹层 |
| `screens/04-duplicate-dialog.png` | 复制知识库弹层 |
| `screens/05-overview.png` | 概览整页长图 |
| `screens/06-copy-overview.png` | 副本概览（计数全 0） |

## 第二轮：管理能力补齐（同日）

同一套环境与账号，追加种子：第二个知识库「归档手册」并置为停用，用于筛选验证。

| 检查 | 结果 |
|---|---|
| 列表「按启用状态筛选」选「停用」后只剩归档库，URL 为 `?status=disabled`；切回「全部状态」恢复两个库 | 通过（`07-list-status-filter.png`） |
| 「管理标签」弹层行内重命名「流程」→「已发布流程」，列表立即显示新名 | 通过（`08-tag-rename.png`） |
| 概览「最近活动」显示创建知识库 / 更新知识库 / 导入文档 / 重命名标签，按时间倒序，操作者在右 | 通过（`09-overview-activity.png`） |
| 设置弹层「分块预览」按表单当前分块长度与重叠切分示例文本，输出「4 块 · 平均 60 字符 · 最小 29 · 最大 114」 | 通过（`10-chunk-preview.png`） |
| 副本（空库）概览显示「这个库还没有内容」+「上传文档」，受 `knowledge.content.manage` 控制 | 通过（`11-empty-overview.png`） |
| 浏览器控制台无 error / pageerror | 通过 |

| 文件 | 内容 |
|---|---|
| `screens/07-list-status-filter.png` | 列表按停用筛选 |
| `screens/08-tag-rename.png` | 标签行内重命名 |
| `screens/09-overview-activity.png` | 概览含最近活动 |
| `screens/10-chunk-preview.png` | 设置弹层分块预览 |
| `screens/11-empty-overview.png` | 空库概览与下一步 |

### 第二轮未覆盖

- 分块预览只在浏览器验证了默认样例与一次切分；超长样本截断（>50 块）由 api 测试覆盖。
- 最近活动只覆盖 base / document / tag 三类 target；`updateDocument` 等尚未写审计的动作不会出现（后续如需请单独补写入）。
- 状态筛选的键盘操作只走了默认 Tab 顺序，未逐项验证方向键。


## 复现

```bash
# 1. 独立库 + 迁移
docker exec agentport-postgres-1 psql -U agentport -d postgres -c "create database agentport_kb_ui_verify;"
cd packages/db && DATABASE_URL=<...agentport_kb_ui_verify> bun --env-file=../../.env scripts/migrate.js
# 2. 分支 API（端口 3100，指向验证库）
cd packages/api && PORT=3100 DATABASE_URL=<...> bun --env-file=../../.env src/index.ts
# 3. 前端（临时配置把 /api 代理到 3100）
cd packages/web && vite --config <临时配置>   # port 5273
# 4. 用真实接口建 profile / 知识库 / 文档 / 文件夹 / 标签 / Wiki 页，再用浏览器走上面表格
```

## 未覆盖

- 只跑了 Chromium，未验证 Safari/Firefox；未做读屏与键盘全流程。
- 无权限视角的按钮隐藏由 `packages/web/test/knowledge-overview.test.ts` 覆盖，未在浏览器里用受限账号复验。
- 概览的最近任务在 worker 未启动时恒为「排队中」，未验证运行中/失败状态的实时刷新。

## 第三轮：置顶与活动覆盖扩展（同日）

同一套环境，追加动作：PATCH 文档标题、新建标签「验收」、整库重建；再在列表页置顶「产品手册」。

| 检查 | 结果 |
|---|---|
| 初始顺序「归档手册 / 产品手册」；置顶产品手册后变为「产品手册 / 归档手册」，行内出现 `Pin` 图标 | 通过（`12-list-pinned.png`） |
| 行菜单变为「取消置顶」，取消后顺序恢复 | 通过 |
| 概览「最近活动」出现 重建索引 / 新建标签 / 更新文档 / 更新知识库 | 通过（`13-overview-activity-extended.png`） |
| 控制台无 error | 通过 |

| 文件 | 内容 |
|---|---|
| `screens/12-list-pinned.png` | 置顶后的列表顺序与图钉 |
| `screens/13-overview-activity-extended.png` | 扩展后的最近活动 |

### 第三轮未覆盖

- 置顶只验证了单账号；跨账号隔离由 api 测试覆盖（两个账号各自 pin 互不影响）。
- 删除类事件（删文档、删标签、删库）不会出现在活动流：target 行已不存在，`exists` 回连失败；审计本身仍可在全局审计页查到。
- 置顶切换中的并发点击未压测。

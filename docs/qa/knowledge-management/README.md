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

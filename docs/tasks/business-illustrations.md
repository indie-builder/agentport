# 统一品牌业务插画系列

## 目标

为业务页空态补齐一套统一品牌插画，沿用白色卷毛木工小狗、黑线白主体、灰木与黄色点缀；统一经 `BusinessIllustration` 接入，不改业务接口、后端、数据与权限。

## 当前有效契约

- 插画静态、无文字、透明背景、无动画；品牌 Logo、专家头像与 `public/brand/scenarios/` 六张场景图保持原样。
- `public/brand/scenarios/` 的「品牌 Logo 切换专用」限制**一直有效**，本次没有被替代；早先记录的「已替代 scenarios 限制」不成立，`docs/DESIGN-SYSTEM.md` 与实现无冲突。
- 接入只有两个容器：`EmptyState` 用新增的 `illustration` 槽替换原 40px 圆底图标；行内 `PageNote` 继续用现有 `icon` 槽，不转成 `EmptyState`。
- 有真实下一步动作的空态保留原按钮与无障碍语义；插画本身 `alt=""`、`aria-hidden="true"`，不参与可访问名称与交互。
- 用户现已明确授权提交、推送、创建 PR、合并并收尾本工作区（执行前不得记作已合并）；此前「未授权 Git」仅为历史状态。

## 生成与素材

- 首次用 gpt-image-2.5 生成时报 EOF、无产物；之后改用 gpt-image-2 生成整组 4×3 母版并做白底修正，再由本地外连通去背、切图与压缩。参考 `pace-wordmark` 与 `pace-empty`。
- 最终业务素材目录为 `packages/web/public/brand/business/`，场景为 `knowledge`、`documents`、`tools`、`search`、`schedule`、`runs`、`memory`、`outputs`、`agents`、`review`、`sharing`、`not-found`。
- 素材规格已确认：12 张 384×384 透明 WebP，合计 389878B（约 381KiB），单张 25008–37368B。
- 尺寸只有三档：`compact` 64、`standard` 96、`error` 144。
- 母版、处理脚本与调试产物只存在于任务临时目录，收尾时已直接删除、不归档；正式仓库只保留上述 WebP。

## 代码接入

源代码接入已完成：`EmptyState` 增加 `illustration` 槽，`BusinessIllustration` 统一渲染。`s.$shareId.tsx` 只在已确认 `invalid` 时显示 `not-found` 图，加载中与请求错误不加图，token/请求/正文行为未改；已安装插件弹窗改用 `illustration`，`PackagePlus` 其他用途保留。

实际覆盖清单（主题 → 页面/状态）：

- `knowledge` → 仅知识库列表空态、知识库详情外部来源空态。
- `documents` → 知识库详情文档空态（未筛选）、插件详情无支持文件空态。
- `tools` → 技能库空态、技能市场榜单空态、连接器空态、插件列表空态、已安装插件弹窗空态。
- `search` → 知识库列表搜索无匹配、知识检索（未输入与无结果）、技能/连接器/插件/智能体/运行搜索或筛选无匹配、文档筛选无匹配、有 documentId 的处理记录空态。
- `schedule` → ops 定时任务空态。
- `runs` → 运行列表空态、评估运行空态、知识库处理任务空态（无 documentId）。
- `memory` → 专家记忆初始化空态（`pages/memory-panel`），不是个人记忆。
- `outputs` → 对话成果空态（未打开会话、无成果文件）。
- `agents` → 对话「先创建一位专家 / 暂无可用专家」、评估无专家、专家列表无可用专家（无创建权限时）。
- `review` → 历史回顾空态、评估用例空态。
- `sharing` → 个人分享空态。
- `not-found` → 404 页面、公开分享失效态。

不在此次范围，未改动：`run-detail` 等待态、专家记忆编辑器、失效专家错误。

## 验证（真实结果）

自动化：

- `pnpm --filter @agentport/web typecheck` 通过；最终 web build 在全部资源就绪后通过。
- `pnpm lint:focus`、`pnpm lint:contract` 通过；biome 21 个文件通过；impeccable detect 返回空。
- 主会话 13 个 web 测试文件共 208 项通过：6 个文件 123 项、4 个文件 48 项、`public-share` 10 项、`output-share` 与 `knowledge-source-forms` 27 项。jsdom 输出 `scrollTo`/navigation 未实现警告，无失败。
- 独立 Opus 代码审查与固定 diff 终审均通过。基线 `2c7f3bf`，diff SHA256 `7a8c768270e0fa0d877183f6bfbcb51a1a90930e674eab0b8d6918a9b9f8ce92`。

浏览器（ego isolated，fetch mock + 真实 routeTree 与页面；不写共享 DB、不登录）：

- 12 个主题资源全部 HTTP 200，均解码为 384 像素。
- gallery 26 个实例在 `compact` 64 / `standard` 96 / `error` 144 三档实测尺寸正确。
- 查看 knowledge / skills / share 截图；白底、灰底 contact-sheet 检查无裁断，主体白色保留。
- 知识库、技能、分享、聊天、评估、来源、检索、处理记录等页面状态检查：单一 `h1`、无横向溢出。
- 1024×768 下额外检查 7 个路由：无横向溢出，按钮在视口内。
- 键盘与 AX：知识库创建按钮 Tab 到搜索框时 `focus-visible` 正常；插画不进入 Tab 顺序，AX 树无插画名称。

真实服务（本 worktree）：

- 前端由 `pnpm --filter @agentport/web dev` 启动，URL `https://worktree-business-illustrations.agentport.localhost`，复用已在运行的 `localhost:3000` 后端；配置来自主 checkout 的 `.env`，未输出凭据。
- 已通过真实表单登录管理员，打开 knowledge / schedules / personal / shares 页面；knowledge 插画解码为 384。
- 本轮未改数据，未覆盖模型链路。

限制：真实服务只验证页面渲染与登录，未改数据，未覆盖模型业务链路。

## 状态与下一步

- 12 张正式资源与代码接入完成；任务临时目录已删除、不归档；用户已通过真实服务完成验收。
- 用户已授权提交、推送、创建 PR、合并并收尾本工作区；截至本文撰写尚未执行，不得记作已合入 main。
- 收尾计划：提交 PR 合并 → 停止本任务前端 → 确认工作区干净、已合入、无人占用 → 删除本工作树并快进主 main；分支保留，不归档。
- 下一步：执行上述已授权的提交、PR 合并与工作区收尾。

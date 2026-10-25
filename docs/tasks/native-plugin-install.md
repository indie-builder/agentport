# 原生插件安装与本地复用

## 目标

用户明确：复用是定义/下载一次，多个专家独立引用，运行时 copy 各自文件；不要求共享挂载。用户先授权设计和落地，验证及独立评审通过后，明确授权本轮提交、创建 PR 并合并。

## 基线与范围

- HEAD `40eafabf6c27147552c1a2e41b69b098bff65940`，新 worktree `worktree-native-plugin-install`，初始干净。
- 允许 shared、DB、API、worker、sandbox、web、相关部署说明与测试；不影响已在3312运行的上一版本预览。

## 方案与有效决定

官方 CLI 是安装器和下载缓存的唯一管理者。安装在现有 worker 启动的一次性 Linux 沙盒中执行，缓存持久挂载到 `/mnt/plugin-cache`（worker workspace 根下 `plugin-cache`），不给业务/模型凭据。不在 API 主机执行第三方包内容，不把安装缓存共享挂载给专家。

流程：原生安装/读取已有缓存 → 受限文本文件快照 → 现有插件库 DB 一份 → 专家绑定 → 每次运行独立复制并按hooks/MCP授权裁剪。ZIP入口保留。DB来源字段用于标识native插件、去重，不另建安装器/缓存格式。

新增界面：从市场安装、选用已安装插件。市场来源只接受GitHub owner/repo和HTTPS Git/marketplace URL，不开放任意shell、本地宿主路径、自动确认命令源。CLI不传 `-y`，需执行市场自定义安装命令时明确拒绝并给提示。

能力范围沿用当前插件文本快照：无二进制/node_modules，不静默漏文件；可执行位从实际文件mode获取。文件入口统一当前parsePluginFiles，不绕过settings/hooks/MCP检查。安装或采纳失败不写半条DB定义；缓存已下载但不能纳入库时如实显示原因。此期不做更新/版本选择/市场搜索。

## 共享契约

- `NATIVE_PLUGINS_QUEUE = 'native-plugins'`，worker并发1，官方注册表写入串行。
- `NativePluginAction`: `{ action:'list' } | { action:'install', marketplace:string, plugin:string } | { action:'read', pluginId:string }`。
- 安装/读取输出：`{ok:true, plugin: NativeInstalledPlugin, files: PluginFileInput[]} | {ok:false,error:string}`；列表输出 `{ok:true,installed:NativeInstalledPlugin[]} | {ok:false,error:string}`。
- `NativeInstalledPlugin`: `{pluginId:string,version:string}`（不向浏览器暴露宿主路径，实际installPath只在安装沙盒内解析）。
- 目录注册表由 `claude plugin list --json` 读取，不手拼缓存版本路径。下载缓存根 `/mnt/plugin-cache/plugins`，`CLAUDE_CONFIG_DIR=/mnt/plugin-cache/config`，HOME/TMPDIR在容器临时目录。
- `/api/plugins/native` GET → `{installed:[{pluginId,version,imported:boolean}]}`。
- `/api/plugins/install` POST body `{marketplace,plugin,slug?}` → `{plugin,warnings,reused:boolean}`。
- `/api/plugins/native/import` POST body `{pluginId,slug?}` → 同上。已入库者返回原对象 `reused:true`，不覆盖。
- DB `plugins.sourceId: string|null` 存官方 `name@marketplace`（ZIP=null），非空唯一；Plugin API同字段。
- `NATIVE_PLUGIN_TIMEOUT_MS=120000`（container action）；API等待150000ms；输出文件累计<=4MiB，每文件<=200000字符，条目<=现有6000，普通UTF8文本、无路径逃逸/符号链接/特殊文件；严守真实信任边界。
- 入口 `packages/sandbox/src/native-plugins.ts`；Docker安装git；worker新模块 `native-plugins.ts` 使用现有DockerSandboxProvider，entrypoint node，command dist/native-plugins.js。
- worker/index由主会话最终注册/关闭；shared schema及exports由基础代理先交付，API/Web与worker/sandbox互不修改。

## 步骤

- [x] shared/DB契约与迁移
- [x] sandbox原生CLI安装与缓存读取，worker队列
- [x] API原生安装/列表/纳入库，统一解析
- [x] web安装及已有插件选择弹窗
- [x] 真实CLI install→list→read验证、重复纳入免下载、独立运行副本/授权不回退
- [x] 独立Opus评审三项修复及复核（来源身份/Redis故障两项通过，活动安装和创建中取消关停通过）

## 验证与下一步

- 新迁移只修改 `plugins`：来源列和唯一索引；已在独立 `native_plugin_verify_20261025` 库应用成功，不修改旧预览数据库。
- `pnpm -r typecheck` 全部通过。
- 汇合后定点回归：19 文件 / 111 测试通过（共享契约、安装器、真实CLI本地市场、离线、worker、API、前端安装/编辑交互）。
- Biome 本轮13个实现文件无诊断，`lint:focus` / `lint:contract` 通过。
- 新sandbox镜像构建成功，实际Linux容器原生安装 `commit-commands@claude-plugins-official`，版本 `58267944f921`，读取6个文件。
- Docker `--network none` 下 list/read 同缓存成功，证明无需重新下载。
- 真实API缓存首次纳入201、重复纳入200/reused且同一插件ID；重复从市场安装返回既有插件200/reused。
- 两个新专家分别绑定同一插件，工作区预览均有全部6个文件，源记录只有一份。
- 浏览器真实登录后可打开安装弹窗，市场字段可见，已安装页列出官方插件与“已加入”状态。
- 额外回归确认既有专家页测试缺少 `usePlugins` mock；补齐两个测试前置后，前端完整套件36文件/331项通过，未改业务行为或删断言。
- 授权边界回归：插件渲染裁剪、子智能体权限、文件只读28项通过。
- 结构化实测证据见 [native-plugin-install-verification.json](native-plugin-install-verification.json)。浏览器可选更新提示未升级。

首轮独立Opus评审发现三项问题。API两项已修复并获定点复核通过：已删除按仓库末段猜市场名的免安装捷径，POST install始终交官方CLI解析完整来源再按规范pluginId复用DB；Redis连接拒绝时禁用重连、限时建连并直接disconnect清理，真实100ms预算故障回归在2秒内返回SERVICE_UNAVAILABLE。两文件12项测试由主会话独立重跑通过。

消费者关停已改为AbortSignal取消活动动作、先启动队列关闭并销毁容器再等待结束；创建中动作可提前取消，晚创建的容器通过abandoned分支销毁。最初新增的创建中关停测试曾超时，未作为通过；修复后worker8项通过，独立Opus定点复核明确通过。最终后端/核心回归28文件195项通过，`pnpm -r typecheck`全包通过；前端全量36文件331项通过；三项修复静态检查、焦点和工程约定通过。首轮三项发现均已修复并获得复核通过结论，本轮可交付未提交差异。

验收临时API/worker（3314/3429）、独立数据库和下载缓存已清理，一次性探针已删除，结构化证据保留。用户已授权发布，下一步提交、创建 PR 并合并 main；不触发或等待 CI，不开启 PR 监控。未修改旧版服务代码或用户数据。

## 交付限制

仅支持可被当前文本快照完整表达的插件，不包含二进制、node_modules和需额外运行依赖的包；超范围明确报错。原生命令源需要人工确认时不自动执行。已知插件ID可从已安装入口无下载加入；从市场安装由官方CLI解析来源，不根据仓库名猜市场身份。不提供自动升级、版本切换或全市场搜索。

真实Docker安装/断网读取已验证；关停使用真实BullMQ加provider替身验证，未额外执行真实30秒SIGTERM部署测试。前端测试存在原有act警告、runner测试有重复SIGTERM listener警告，均未据此声称运行链路通过。

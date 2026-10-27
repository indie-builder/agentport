# 活跃轻量技术栈接入

## 目标与方案

用持续维护的进程内库替换有实际问题的手写逻辑，并将通用选型原则整合进项目 CLAUDE.md。Opus 设计与独立评审、Sonnet 分域实施，主会话验证和交付；不新增部署或托管服务。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/active-lightweight-stack`
- 分支：`refactor/active-lightweight-stack`
- 起始 origin/main：`b2d757b08e4ad6a9076d924a5281f68d712419f3`；初始本树无差异。
- 主 checkout 原有 `.vitest/json/output.json` 不属本轮；其他 worktree 不修改或删除。
- 最终范围：worker 解析与适配器、两份直接测试和四份 Docling fixtures；两份 web 知识测试及 test-only msw.ts；根/worker package 与锁；项目 CLAUDE.md、ARCHITECTURE.md 和本记录。
- web 生产页面、DialogShell 与 web/package.json 恢复基线；没有虚拟化实现或依赖残留。

## 当前有效决定

- 用户授权实施、commit/push、创建并合并 PR、清理本树及更新 main；CI 不触发、不等待、不监控。
- 规则写项目 CLAUDE.md，不写全局；本次误写全局的章节已撤回，全局配置恢复原样。
- 生产新增仅 csv-parse 7.0.3；MSW 3.0.3 仅根开发依赖。无 schema、迁移、新服务或外部账号。
- CSV 保留 BOM、多行引号、不等宽列和表格输出，支持 CR-only；非法引号明确 invalid_input。列宽线性聚合，避免大行数参数栈溢出。
- Markdown 保留轻量线性扫描，最小修复围栏字符/长度/关闭尾部、单行 Setext、无外管道表格、UTF-16 原文定位与 Docling 去重。保留 ParsedBlock、JSON provenance 与切块预算，不宣称完整 CommonMark。
- MSW 仅迁移 knowledge-management/settings 两测试，显式路由、严格未配置请求断言、等待请求体记录。共享清理逐步执行，即使有失败也恢复环境，最后上抛原错误。
- 性能候选必须满足运行成本和 UX/DX/AX；不能用局部提速牺牲内容访问或焦点。

## 已替代项及原因

| 试验/旧方案 | 最终决定 |
|---|---|
| 通用规则写全局文件 | 用户纠正后恢复全局，仅更新项目规则 |
| Markdown mdast/GFM AST | 1MB 单次约864ms/RSS588MiB，混合14→1241ms；运行负担不合格，代码与 worker 直接依赖全部撤回 |
| TanStack Virtual | 500/2000 分块打开约292→82ms、901→90ms，但焦点项卸载、原生查找/辅助技术访问退化，撤回代码、专属测试和依赖 |
| 虚拟化最新版绕过发布等待期 | 临时命令结果不作交付；保护设置未改，最终该依赖整体撤除 |
| MSW 脱离等待链的 body 读取 | 显式等待请求体、读取失败使测试失败，补在途取消 |
| 两份测试各自不完整 finally | 共用 runCleanup；先清空引用，所有清理步骤执行后抛首错，补 clear/remove/unmount/body 故障注入 |

## 实施与评审

- [x] 基线记录、Sonnet 分域实施
- [x] CSV 独立评审通过；15 万行表格栈溢出先红后绿
- [x] Markdown 误去重修复和定点复核通过；三个伪 closer 先红后绿，合法代码仍去重且 JSON 来源优先
- [x] 虚拟化独立评审否决并完整撤回
- [x] 项目通用选型规则独立评审通过；全局文件恢复已核验
- [x] MSW 共享清理和故障测试真实卸载快照最终复核通过，无剩余阻断
- [x] 最终范围验证
- [ ] 本地提交
- [ ] 推送、PR、合并、清树、更新 main（远端连接阻塞）

## 验证

| 验证 | 最终结果 |
|---|---|
| 普通 `pnpm install --frozen-lockfile` | 通过，原供应链保护未修改 |
| `pnpm test:web` | 73 文件720项通过，0失败；保留既有 jsdom navigation 提示 |
| MSW 两文件 | 68项通过；原60项保留，新增请求/二进制/取消/清理边界 |
| worker parsing / adapter / ingestion | 3文件95项通过；CSV、15万行、围栏、页码偏移、Docling去重 |
| `pnpm typecheck` | 7包通过 |
| worker / web build | 通过；既有 chunk 体积提示保留 |
| focus / contract / 11个实现测试夹具 Biome / diff --check | 通过 |

CSV 32MiB/8列单样本：基线1575ms/RSS1188MiB，新660ms/RSS331MiB，不外推所有输入。轻量 Markdown 1MB混合39ms/heap52MiB，runner RSS158–220MiB；AST 已撤回。原始列表基准保留在未跟踪 `.tmp/bench`，不提交临时工具。

## 文档冲突与限制

- 项目通用规则与最终解析事实已同步；评估文件交换的 JSON-only 规则不变，不能把知识 CSV 解析误解成新增评估 CSV 导入。
- 轻量 Markdown 不覆盖完整 CommonMark，MSW cookie 不能证明真实登录。未跑完整产品 E2E、真实模型、企业来源或 Docling compose 验收。
- 全仓既有未触及的格式问题不扩入本任务；测试生成报告不得混入提交。

## 下一步与发布阻塞

实现、最终范围验证与各域独立 Opus 评审均通过，无剩余阻断，准备保存已授权的本地提交。Git/gh HTTPS 因代理签发证书不受信任失败，保留 TLS 校验的直连及已知主机 SSH 22/443 亦不可用。不得关闭证书校验或修改系统信任来发布，不得把 fetch 失败当远端无新提交。连接恢复后正常 fetch/rebase或整合、必要定向验证，再 push/PR/merge；未合并工作区保留，本地 main 不包含本任务。

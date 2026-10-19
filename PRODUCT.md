# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

TypeScript monorepo: React 19 + Vite 8 + Tailwind CSS 4 + shadcn/ui 结构的自建组件；Fastify 5 + zod 4 后端；Claude Agent SDK；PostgreSQL 18 + Redis 8。

## Users

单一管理员兼操作员（内部平台的首个用户）。他们在自己的工作站上配置 MCP Server、定义智能体、然后通过对话让智能体执行任务。使用场景是长时间在线的桌面浏览器，任务往往是「配置一次、反复运行」，需要快速判断一次运行是否成功、花了多少、卡在哪一步。

## Product Purpose

PACE 是一个智能体运行平台：把现有的 HTTP API 或 MCP 服务接进来，用可复用的文件定义（`.mcp.json`、`CLAUDE.md`、`.claude/agents/*.md`、skills）描述智能体，再在隔离沙盒里按需运行它。成功意味着：配置一次之后，每次对话都能稳定调用正确的工具，且每一步都可追溯、可停止、可计费。

## Positioning

配置即文件，运行即沙盒。智能体的定义不是数据库里的一串开关，而是 Claude Code 能直接读懂的目录结构；因此同一个智能体既能被本平台运行，也能被任何兼容 Host 直接使用。平台本身把 HTTP API 在运行时挂载成标准 MCP 端点，不生成代码。

## Operating Context

- 桌面浏览器长时间打开，通常并排多个标签页处理其他工作。
- 配置行为低频但要求高准确度：一次命令填错就要重新排查。
- 运行行为高频：同一智能体反复对话，关注首字节延迟、工具调用是否被拒、成本。
- 失败模式以「配置错误」和「权限被拒」为主，其次是模型侧超时。

## Capabilities and Constraints

已确认能力：MCP Server 三种来源（stdio / 远程 HTTP / HTTP API 转 MCP）、连接测试、智能体文件定义与 Skill、沙盒运行、流式事件、历史会话、审计、限流、健康检查。

约束：单机部署优先；沙盒必须与宿主隔离；密钥不得出现在日志、响应或工作区文件中；内置工具默认禁用，只允许 MCP 工具。

## Brand Commitments

产品名 **PACE**。语气克制、精确，不使用感叹号与营销话术。界面语言为中文，技术标识保留英文原形。仓库与包名保持 `agentport`。

## Evidence on Hand

真实可用的端到端链路：模型在沙盒内调用生成的 MCP 工具并取得上游 API 数据，事件经 SSE 到达客户端，已在本机实测。没有客户案例、benchmark 或第三方背书，未来工作不得虚构。

## Product Principles

1. **可解释**：任何一次运行都能回答「谁、用了哪个工具、参数是什么、结果如何、花了多少」。
2. **配置即契约**：界面上的每一个字段都能在生成的文件里找到对应位置，反之亦然。
3. **失败要可诊断**：错误信息指出问题与下一步，而不是只说「失败了」。
4. **默认安全**：默认禁用内置工具、默认脱敏、默认可取消。
5. **信息密度优先**：为反复使用的操作界面优化，而不是为首次访问的展示页优化。

## Accessibility & Inclusion

键盘可完成全部操作；正文对比度 ≥ 4.5:1；焦点可见；动效遵守 `prefers-reduced-motion`。

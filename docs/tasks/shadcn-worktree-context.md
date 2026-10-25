# shadcn 技能在 worktree 中的项目上下文

## 目标

修复 shadcn 技能在 monorepo 根自动查询上下文时报 `monorepo_root` 的问题，确保命令读取当前 worktree 的 `packages/web`。

## 方案

- 动态命令使用 `pnpm dlx shadcn@latest info --json -c packages/web`。
- 项目相关命令从当前 checkout/worktree 根执行，正文示例显式指定 `-c packages/web`；顶部约定同时覆盖引用资料中的通用例子。
- 新建项目及后续操作使用新项目实际目录；registry 命令使用实际 registry 目录；`preset decode/url/open` 保留无 cwd 参数的语义。
- 保留 `.claude/skills/shadcn` 的相对符号链接，无需新增脚本、配置或依赖。

## 步骤

- [x] 修改动态查询及项目目录约定
- [x] 统一本文件中的 runner 和项目相关示例
- [x] 在新 worktree 复现原错误并验证修改后的实际命令
- [x] Opus 独立 review：通过，未发现本次改动引入的错误或遗漏

## 改动文件

- `.agents/skills/shadcn/SKILL.md`
- `docs/tasks/shadcn-worktree-context.md`

## 下一步

实现、验证与 Opus 独立 review 均已完成，改动范围仅上述两个文件；交付动作随本次 PR 合并完成，合并后不再单独提交文档。已有 worktree 需在修复合入后同步相应提交。

## 验证

从 `shadcn-worktree-context` worktree 根执行：

- `pnpm dlx shadcn@latest info --json`：退出码 1，复现 `monorepo_root`，候选为 `packages/web`。
- 从修改后的 `SKILL.md` 提取实际动态命令并通过 Node `execFileSync` 执行：退出码 0；断言 `resolvedPaths.cwd` 等于当前 worktree 的 `packages/web` 实际路径，`framework` 为 `Vite`、`base` 为 `base`，返回 27 个组件。
- `pnpm dlx shadcn@latest docs button -c packages/web`：退出码 0，返回 `/docs/components/base/button` 和 Base UI 示例地址。
- `pnpm dlx shadcn@latest preset resolve --json -c packages/web`：退出码 0，返回当前项目预设。
- 通过 Node `realpathSync` 断言 `.claude/skills/shadcn` 指向当前 worktree 内的 `.agents/skills/shadcn`：通过。

仅调整技能文档，未运行应用构建或全量测试；未执行会修改组件或预设的安装/初始化操作。

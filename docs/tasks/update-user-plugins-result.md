# 更新全部 scope=user 已安装插件（2026-10-27）

## 1. 任务与范围

- 目标：把所有 `scope=user` 的已安装 Claude Code 插件更新到各自 marketplace 当前发布的最新版本。
- 按用户当次明确授权，**包含禁用但已安装的用户级插件**（覆盖 `docs/SKILLS.md`「排除禁用项」的默认范围），并保持原有启用/禁用状态。
- 只操作用户级插件缓存与注册表（`~/.claude/plugins/`）；未改动任何项目配置或源码，执行中未卸载重装、未主动删除缓存/runtime/持久数据，未改变 marketplace 来源与 pin。持久数据未保存更新前完整清单，因此不宣称已验证其更新前后逐文件一致。
- 执行依据：`docs/SKILLS.md` §插件更新、`docs/PITFALLS.md` 相关条目；官方 `plugins/loading.md`、`install.md`（主会话已核对）。CLI：`2.1.311`。
- 本记录文件由执行子代理单独负责；未 commit/push/merge。

## 2. 备份

备份目录（独立临时目录，未输出敏感内容）：

```text
/tmp/claude-user-plugins-backup.ArZv0I/
```

| 文件 | 说明 |
| --- | --- |
| `plugin-list-before.json` / `plugin-list-after.json` | 操作前后 `claude plugin list --json` 快照 |
| `installed_plugins.json` / `installed_plugins-after.json` | 操作前后注册表 |
| `known_marketplaces.json` / `known_marketplaces-after.json` | 操作前后 marketplace 注册表 |
| `plugin-directory-bindings-after.json` | directory marketplace 绑定（操作后） |
| `catalogs-before/` | 涉及的 9 个 marketplace 的 `marketplace.json` 与官方 `.gcs-sha` |
| `cache-manifest-before.json` / `cache-manifest-after.json` | 22 个用户插件的缓存文件清单（路径 + SHA-256） |

辅助脚本与只读上游快照位于 `/tmp/claude-plugin-audit/`（脚本与下载数据分目录存放）。

## 3. 操作序列

### 3.1 marketplace catalog 刷新（仅涉及用户插件的 9 个，串行）

| marketplace | 结果 | catalog pin 变化 |
| --- | --- | --- |
| claude-plugins-official | ok | GCS sha `41f619d6…` 未变 |
| claude-code-warp | ok | `53ab8d63…` 未变 |
| claude-hud | ok（重新 clone） | `3bb6835f…` → `cf95a322…`；catalog version 0.13.0 → 0.13.1 |
| interfaces | ok（重新 clone） | `9790cabd…` → `592aedc4…` |
| ponytail | ok | `09c434ab…` 未变 |
| typesafe-ai | ok | `302eea66…` 未变 |
| compound-engineering-plugin | ok（重新 clone） | `1522cc36…` → `00d0a5bb…` |
| evoontology | ok | `c94389b7…` 未变 |
| cursor-plugins | ok（重新 clone） | `99b609a7…` → `519d36aa…` |

未刷新与用户插件无关的 6 个 marketplace（并保持其来源/pin 不变）。所有 marketplace 的 `source` 字段操作前后一致。

### 3.2 逐插件更新（22 个，串行；`--scope user --json`）

| 插件 | marketplace | 状态 | 更新前 | 更新后 | outcome |
| --- | --- | --- | --- | --- | --- |
| agent-sdk-dev@claude-plugins-official | claude-plugins-official | 禁用 | 41f619d61b99 | 41f619d61b99 | up_to_date |
| claude-code-setup@claude-plugins-official | claude-plugins-official | 禁用 | 1.0.0 | 1.0.0 | up_to_date |
| claude-hud@claude-hud | claude-hud | 禁用 | 0.13.0 | **0.13.1** | updated |
| compound-engineering@compound-engineering-plugin | compound-engineering-plugin | 启用 | 3.32.1 | **3.33.1** | updated |
| evoontology@evoontology | evoontology | 启用 | 1.1.1 | 1.1.1 | up_to_date |
| gopls-lsp@claude-plugins-official | claude-plugins-official | 启用 | 1.0.0 | 1.0.0 | up_to_date |
| interfaces@interfaces | interfaces | 启用 | 1.16.0 | **1.17.0** | updated |
| kotlin-lsp@claude-plugins-official | claude-plugins-official | 启用 | 1.0.0 | 1.0.0 | up_to_date |
| learning-output-style@anthropic-plugin-directory | anthropic-plugin-directory | 启用 | 1.0.0-41f619d61b99 | 1.0.0-41f619d61b99 | up_to_date |
| mattpocock-skills@claude-plugins-official | claude-plugins-official | 启用 | 1.3.1 | 1.3.1 | up_to_date |
| mcp-server-dev@claude-plugins-official | claude-plugins-official | 禁用 | 41f619d61b99 | 41f619d61b99 | up_to_date |
| plugin-dev@anthropic-plugin-directory | anthropic-plugin-directory | 启用 | ad30d62cd52a-04b3e1d6 | ad30d62cd52a-04b3e1d6 | up_to_date |
| ponytail@ponytail | ponytail | 启用 | 5.3.2 | 5.3.2 | up_to_date |
| pstack@cursor-plugins | cursor-plugins | 启用 | 0.15.32 | **0.15.34** | updated |
| pyright-lsp@claude-plugins-official | claude-plugins-official | 启用 | 1.0.0 | 1.0.0 | up_to_date |
| ralph-loop@claude-plugins-official | claude-plugins-official | 禁用 | 1.0.0 | 1.0.0 | up_to_date |
| rust-analyzer-lsp@claude-plugins-official | claude-plugins-official | 启用 | 1.0.0 | 1.0.0 | up_to_date |
| skill-creator@claude-plugins-official | claude-plugins-official | 禁用 | 41f619d61b99 | 41f619d61b99 | up_to_date |
| swift-lsp@claude-plugins-official | claude-plugins-official | 启用 | 1.0.0 | 1.0.0 | up_to_date |
| typesafe@typesafe-ai | typesafe-ai | 启用 | 0.6.2 | 0.6.2 | up_to_date |
| typescript-lsp@claude-plugins-official | claude-plugins-official | 启用 | 1.0.0 | 1.0.0 | up_to_date |
| warp@claude-code-warp | claude-code-warp | 禁用 | 2.4.0 | 2.4.0 | up_to_date |

结果：22/22 `outcome: ok`，失败 0，4 个实际升级；启用/禁用状态全部保持不变。

## 4. 缓存与发布来源核验

### 4.1 对照来源（按各插件当时的发布 pin，不用任何仓库 main 代替 pin）

| 来源类型 | 插件 | 对照点 |
| --- | --- | --- |
| marketplace 根目录 `"./"` | claude-hud / interfaces / ponytail / typesafe / compound-engineering | 克隆 HEAD，且与注册表 `gitCommitSha` 一致：`cf95a322…` / `592aedc4…` / `09c434ab…` / `302eea66…` / `00d0a5bb…` |
| marketplace 子目录 | pstack / evoontology / warp / 官方仓库内插件 | `cursor-plugins@519d36aa`、`evoontology@c94389b7`、`claude-code-warp@53ab8d63`、官方 GCS 快照 `41f619d6…` 对应目录 |
| 外部 url + sha pin | mattpocock-skills | `https://github.com/mattpocock/skills.git` @ `49dd158d1076134a641b33efb035946536778336`（codeload 只读快照） |
| directory marketplace | plugin-dev / learning-output-style | `anthropics/claude-plugins-official` @ `ad30d62cd52a…`（plugin-dev 的 pin）/ `41f619d6…`（learning-output-style） |

### 4.2 结果

22/22 插件：`missing=0`、`extra=0`、`content_diff=0`（逐文件 SHA-256）。

仅排除以下有证据的类别：

| 排除类别 | 证据 |
| --- | --- |
| `node_modules/` | 缓存内为安装生成的依赖树，上游快照无此目录；claude-hud 1464 个、compound-engineering 11635 个、mattpocock-skills 1642 个文件，均在 `node_modules/` 下 |
| `.in_use/<pid>` | CLI 写入的“使用中”标记；12 个插件各 3 个，内容为 PID，非插件内容 |
| `__pycache__/` | evoontology 23 个 `.pyc`，运行期生成 |
| `.git/` | 版本库元数据；上游快照已排除，缓存内不存在 |

无同版本缓存漂移，未执行任何强制重装或手改缓存。

## 5. 活动组件核验

启用插件均存在可加载组件（`plugin.json` 声明路径 + 自动发现目录；skill 均含 `SKILL.md`；hook 命令处理器引用的 `${CLAUDE_PLUGIN_ROOT}` 脚本均存在）。

| 插件 | skills | commands | agents | hook 处理器 | 其他 |
| --- | --- | --- | --- | --- | --- |
| compound-engineering | 36 | 0 | 0 | 0 | — |
| evoontology | 3 | 0 | 0 | 1 | `.mcp.json` |
| interfaces | 14 | 0 | 0 | 0 | — |
| learning-output-style | 0 | 0 | 0 | 1 | — |
| mattpocock-skills | 38 | 0 | 0 | 0 | — |
| plugin-dev | 7 | 1 | 3 | 0 | — |
| ponytail | 6 | 0 | 0 | 3 | — |
| pstack | 58 | 0 | 2 | 0 | — |
| typesafe | 1 | 0 | 0 | 0 | — |
| 6 个 LSP 插件 | 0 | 0 | 0 | 0 | 组件由官方 catalog `lspServers` 声明 |

LSP server 可执行文件在 PATH 上的现状（环境事实，非本次更新造成）：

| 插件 | 命令 | 可用 |
| --- | --- | --- |
| gopls-lsp | gopls | 否 |
| kotlin-lsp | kotlin-lsp | 否 |
| pyright-lsp | pyright-langserver | 否 |
| rust-analyzer-lsp | rust-analyzer | 是 |
| swift-lsp | sourcekit-lsp | 是 |
| typescript-lsp | typescript-language-server | 否 |

## 6. 范围隔离与副作用

- 项目级插件条目（7 个 project scope）版本、安装路径、`lastUpdated` 均未变化。
- 旧版本缓存目录保留（claude-hud 0.13.0、compound-engineering 3.32.1、interfaces 1.16.0、pstack 0.15.32 均存在）。
- `~/.claude/settings.json` 未被修改；插件执行代理只写本记录，未触碰同一 worktree 内由并行 Skills 代理和主会话产生的本任务差异。
- 所有 marketplace `source` 操作前后一致；directory binding 仅保存了操作后快照，未主动更改绑定，但缺少操作前快照，无法独立证明前后一致。

## 7. 未完成事项与风险

1. **无更新失败项**：22 个用户插件全部 `ok`，缓存与发布来源零差异。
2. **生效时机**：4 个 updated 插件的磁盘版本已更新；在当前会话执行 `/reload-plugins`，或重启 Claude Code / 开启新会话后加载新版。若重载提示需要 `--force`，按提示处理；monitors 需要重启会话。
3. **LSP 可执行文件缺失**：gopls、kotlin-lsp、pyright-langserver、typescript-language-server 不在 PATH，相关插件虽为启用状态但对应 server 无法启动。属环境配置问题，本次更新未改变该状态，也未擅自安装。
4. **备份寿命**：备份在 `/tmp` 下，系统重启/清理后可能丢失；若需长期保留请转存。
5. 本次未覆盖 project scope 插件（严格按用户指定的 user scope 范围）。
6. **证据边界**：未保存持久数据的操作前完整清单；directory binding 也只有操作后快照。未执行主动删除或改绑，当前未发现丢失，但两者无法做完整前后独立比对。

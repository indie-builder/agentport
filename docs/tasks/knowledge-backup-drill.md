# 真实 backup + restore 演练（知识库目录）

日期：2026-10-25 · 范围：只验证 `scripts/backup.sh` / `scripts/restore.sh`，不改产品代码。

## 结论

真实 `backup.sh` 产出的完整归档，经真实 `restore.sh` 恢复到另一个新库和两个空目录后，
数据库行、工作区/知识库字节、权限、manifest 全部一致。演练脚本与日志保留在
`.tmp/knowledge-backup-drill/`（未提交，`.tmp/` 已在 `.gitignore`）。

## 隔离方式（不碰主栈）

| 项 | 值 |
| --- | --- |
| Postgres | 现成的 `pace-knowledge-research-pg`（127.0.0.1:55432，容器内 18.6） |
| 备份源库 | `pace_knowledge_backup_drill`（演练时新建，结束后删除） |
| 恢复目标库 | `pace_knowledge_restore_drill`（同上） |
| 宿主 pg 客户端 | 宿主没有 pg_dump，也没有 18 客户端；`.tmp/.../bin/pg-wrapper` 把 `pg_dump`/`pg_restore`/`psql` 透传给容器内真实二进制 |
| 客户端选择 | `PG_CLIENT=host`（v3 的 `host` 表示「用 PATH 里的客户端」，wrapper 即在 PATH 首位） |
| 演练 ROOT | `.tmp/knowledge-backup-drill/root/`，`scripts` 软链到本 worktree，`docker-compose.yml` 只含不存在的 api/worker（保证 compose 探测不指向主栈） |
| 数据目录 | `.tmp/knowledge-backup-drill/fixtures/{workspaces,knowledge}` + `dummy.env`（无真实密钥） |

wrapper 只接受 `pace_knowledge_backup_drill` / `pace_knowledge_restore_drill` 两个库名，
其余（含主库、无 URL）直接退出 2，不打印 URL 与凭据；`--version`/`--list` 原样透传。

## 复现

```bash
bash .tmp/knowledge-backup-drill/run-drill.sh   # 重建两库 + 迁移 + 造数 + backup + restore
bash .tmp/knowledge-backup-drill/verify.sh      # 断言
bash .tmp/knowledge-backup-drill/negative.sh    # 反向校验
bash .tmp/knowledge-backup-drill/cleanup.sh     # 删除两个演练库与临时文件
```

演练场景含：迁移出的完整 schema（38 表）+ 34 条 drizzle 迁移记录、按外键链造的
servers/profiles/knowledge_bases/knowledge_documents/versions/chunks 与 agents/conversations/messages；
工作区含 `agent-memory/`（应保留）、`run_*/`、`sandbox-probes/`、`.restore-staging-*`（后三者应被剪掉）；
知识库含随机二进制 blob 与多级 markdown。

## 实测结果（2026-10-25 22:02，同一轮）

- `BACKUP OK .../20261025-220246.tar.gz`：database 108298 B、workspaces 2 files、knowledge 3 files，归档权限 0600。
- `RESTORE OK`：库、配置（侧验模式不写）、工作区、知识库、`pnpm db:migrate`（`migrations applied`）。
- 数据库：10 张自造/关键表 `count + md5(整行文本)` 源库与目标库完全相同（含 `drizzle.__drizzle_migrations`）。
- 工作区：2 个 `agent-memory` 文件 sha256 与源一致，派生目录已被剪除。
- 知识库：3 个文件 sha256 一致（含随机二进制）。
- 权限：恢复出的目录 0700、文件 0600（目标根目录本身沿用调用方 umask，0755）。
- manifest：`knowledge.sha256/files/bytes` = `2d4cb674…5b91 / 3 / 8240`，与恢复目录重算值一致。
- 反向：非空 `--target-workspaces` 在改库前被拒；wrapper 拒绝主库 URL、拒绝无 URL 的 `pg_dump`；日志无凭据。

## 环境备注（非产品缺陷）

- 演练 ROOT 里跑 `pnpm db:migrate` 会先触发一次隐式 install，因缺 catalog 报
  `ERR_PNPM_CATALOG_ENTRY_NOT_FOUND_FOR_SPEC`（warning 后继续），迁移本身成功。真实部署 ROOT 有完整
  `pnpm-workspace.yaml`/lockfile，不会出现。演练时按需给 ROOT 补了 `verifyDepsBeforeRun=false` 与最小 workspace 配置。
- 验收脚本早期两次失败均为 harness 自身问题（脚本软链指向主 checkout 的旧 `restore.sh`、wrapper
  `--dbname` 拼接写坏），修正后重跑通过；这两处不是产品脚本的问题。

## 未覆盖

- restic 远端推送、保留策略、`pre-restore-*` 安全副本的回滚路径（本轮只看它被正确生成）。
- 容器/卷模式（WS_MODE=exec/run、KN_MODE=exec/run）：本轮全走 host 模式。
- 真实 `.env`、主 PG、主 volume 全程未读取。

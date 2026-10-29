# 备份恢复有限发现

## 目标

只处理 codebase-review-loop 报告的备份/恢复发现，不扩大到其他问题（第 3 项为本轮限定修复，前两项已过 review、本轮不再改）：

1. `scripts/restore.sh` 生成恢复前安全副本时，`install "${ENV_SOURCE}"` 失败会写一个空 env 并继续恢复；但 `validate_archive`（`scripts/backup-lib.sh`）拒绝空 env，导致这份安全副本不能作为回退点，破坏性恢复却已经开始。现存但空/不可复制的配置必须在改库前中止；本地配置**原本不存在**（新机器灾难恢复）且调用方显式给了 `DATABASE_URL` 时仍必须能恢复。
2. `scripts/backup-lib.sh` 的 `ws_swap_script` 只在 holding 旧目录与目标新目录**同时存在**时回搬 `run_*`。恢复较旧备份时，当前工作区里新增的专家目录不在备份中，目标目录不存在，`run_*` 随 holding 一起被删除；这些 `run_*` 被备份明确排除，安全副本里也没有第二份。
3. （本轮限定修复）`scripts/restore.sh` 生成的安全引导 env 用 `'\''` 转义 URL 里的单引号；但 `backup.sh` / `restore.sh` 现有读取流程只去掉首尾引号，不反解该固定序列，含真正单引号的 `DATABASE_URL` 读回后密码被改写。生成的格式必须能被自身读取流程还原成原字节。

验收：先写会失败的行为测试并确认失败原因；修复后用完整 `packages/worker/test/backup-script.test.ts`、`bash -n`、biome、diff 检查验证；前两项的真实 PG 演练证据保留，本轮无新疑点不重跑。不提交，交 Opus review。

## 方案

- 安全副本：区分三种配置状态。①本地配置路径不存在：用已解析并导出的目标 `DATABASE_URL` 生成一份非空最小引导 env（只含该 URL 与一行说明，单引号包裹并按 POSIX shell 规则转义），明确原本没有本地密钥；安全包照常走 `validate_archive`，不退回空 env；实际恢复后的配置仍使用已校验归档里的 env。②路径存在但为空/不可读/非普通文件：改库前中止。③复制失败：改库前中止。安全包发布后复用 `validate_archive` 复核，失败则删除并中止。
- 工作区换入：对 holding 中带 `run_*` 的旧目录，目标父目录不存在时按需 `mkdir -p`，并把该目录名加入现有 `.swapped` 回滚清单；原 EXIT trap 会先把已搬入的 `run_*` 归还 holding，再整体恢复原目录，不会只留下分散副本。`mv` 失败仍由原 trap 报错并以非零退出。
- 引导 env 读取（本轮）：只在单引号包裹的生成格式下，去掉首尾引号后把固定序列 `'\''` 反解为 `'`；双引号/无引号分支沿用原有读法。反解用变量承载替换字符，因为实测 `${v//\'\\\'\'/\'}` 的替换串会保留反斜杠得到 `\'`，并非裸引号。不新增通用 env 解析器、不 eval、不 source 归档 env。
- 三项都在同一个测试文件内完成，单一作者，不并发改同一文件。

## 基线与范围

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-review-loop`
- 分支：`worktree-codebase-review-loop`
- 基线：`HEAD` = `e060e3a559633a0d94adb637516a6d577b86b1aa`
- 开工时本任务独有的文件均无未提交差异：
  - `scripts/restore.sh`
  - `scripts/backup-lib.sh`
  - `scripts/backup.sh`（本轮新增范围，读取片段与 restore 共用同一格式）
  - `packages/worker/test/backup-script.test.ts`
  - `docs/tasks/codebase-review-restore.md`（本记录）
- 工作树内其他已修改/未跟踪文件来自并行任务，不属于本任务，不提交、不还原、不覆盖。
- 允许改动：仅上述 5 个文件，且本轮只改 `scripts/restore.sh`、`scripts/backup.sh` 的既有 `DATABASE_URL` 读取片段与测试/记录；不改 `backup-lib.sh` 已过 review 的回滚逻辑；`docs/OPERATIONS.md` 由后续统一作者同步（已完成，见文末）。

## 当前有效决定

- 用户本轮明确：只修最后一项（引导 env 的引号往返），不派代理、不提交；已过 review 的缺 env/坏配置中止与部分 `run_*` 回滚不再改；不得修改生产数据库/工作区/主 `.env`/共享服务。
- 用户本轮明确：保留 URL 安全写入、显式 `DATABASE_URL` 优先和普通配置读取行为；不写通用 env 解析器、不 eval、不 source 不可信归档；先红后绿。
- 实现约束（来自 review / 证据纪律，非用户指定）：source 安全用例不得冒充脚本读取往返；引导 env 的生成格式必须能被脚本自身读取流程还原。
- 用户本轮明确：任务记录中原先夸大的特殊字符覆盖声明要按实际测试范围修正；不得把执行方的实现方案写成用户授权。
- 实现选择（由执行方确定、非用户指定，已由 Opus `a3d703` 复核通过）：缺本地 env 时生成最小引导 env，现存空/不可读/复制失败时中止；`run_*` 回滚完整归还 holding；读取单引号生成格式时反解固定转义序列。
- 若静态发现不成立则不改，不照结论硬实现。
- 不新增依赖、服务或理论风险防护。

## 已替代项及原因

- 上一轮的「缺失本地 env 必须无条件中止」被替代：它来自错误的实现方案，不是用户决定，也不符合 `restore.sh` 原本的灾难恢复语义（新机器没有 `.env`，只靠显式 `DATABASE_URL` 恢复）。现改为「不存在 → 生成最小引导 env；现存但空/不可读/复制失败 → 中止」。
- 上一轮记录里「未发现新冲突」的结论不成立：本轮的独立 review 发现上述两项（安全副本破坏灾难恢复、`run_*` 回滚分散），已在本记录与实现中修正。
- 上一轮「只建目标父目录、不扩充回滚清单」的做法被替代：`mv` 第二个 `run_*` 失败时会留下分散副本，现把按需新建目录纳入 `.swapped`。
- 上一轮记录里「同一个 env 再作为 `BACKUP_ENV_FILE` 由脚本读回同一目标库」对含引号 URL 不成立：当时只有无引号 URL 走过脚本读回，`source` 安全用例不能代替脚本读取。现补含真正单引号的往返用例并修正该表述。
- Opus 建议的 `${DATABASE_URL//\'\\\'\'/\'}` 经实际 Bash 验证，替换串会保留反斜杠得到 `\'`，不是裸 `'`；改用变量 `SQ_CHAR` 承载替换字符后再反解。

## 步骤

- [x] 先核对现有备份/恢复契约（`docs/OPERATIONS.md` §3.1-3.2、`scripts/backup.sh`、`scripts/backup-lib.sh`）。
- [x] 在 `packages/worker/test/backup-script.test.ts` 写失败测试：缺失/空/不可复制配置的三种不同行为；真实隔离库哨兵在配置损坏时保留。
- [x] 写失败测试：仅存在于当前工作区的专家目录，其 `run_*` 在恢复后仍存在；第一个与第二个 `run_*` 搬运失败时都完整回滚。
- [x] 最小修复两个脚本，使测试转绿。
- [x] 跑完整测试、`bash -n`、biome、diff 检查，执行真实 PG 演练，更新本记录。
- [x] 本轮：先写失败用例——含真正单引号的 URL 生成安全包 → 提取引导 env → 清空显式 `DATABASE_URL` → 经 restore 自身读取断言 `pg_restore --dbname` 原字节；同一 env 再由 backup 读取断言一致。确认红因为读回 `'\''` 序列。
- [x] 本轮：在 `backup.sh` / `restore.sh` 既有读取片段加入单引号生成格式的固定序列反解，保持显式 URL 与普通配置分支不变，测试转绿。

## 改动文件

- `scripts/restore.sh`
- `scripts/backup.sh`（本轮）
- `scripts/backup-lib.sh`（前两项，本轮未改）
- `packages/worker/test/backup-script.test.ts`
- `docs/tasks/codebase-review-restore.md`

## 下一步

- 最终已验收：Opus `a3d703` 复核通过（最后 URL 反解；前轮缺 env/坏配置中止与 `run_*` 归位修复同轮通过）。主会话 `byw28qy0g` 完整 42 passed / 0 skipped / exit 0（原始输出 `rtk recall 278485a1b40f3648`）；`bash -n` 与对应 `git diff --check` 通过。未提交差异交付。
- 文档复核：`docs/OPERATIONS.md` 已按独立 Opus review 修正 4 项文档事实（`validate_archive` 复核在安全包改名后、改库前；`pre-restore-<ts>.env` 在数据库提交后复制，与「不改动任何目标」拆开；步骤 5 改「尽力归回」，回搬失败保留现场与 holding；§3.4 改为「恢复命令传入的」参数），待复核。代码与测试未改，仍为 42 tests passed、Opus `a3d703` 通过；文档复核未过不代表代码失败。

## 验证

**红（上一轮修复前，同一测试文件，上一轮最终用例）**

- `pnpm exec vitest run packages/worker/test/backup-script.test.ts` → 41 tests，**6 failed / 35 passed**（70.58s）。
- 失败原因与预期一致：
  - 缺本地 env + 显式 `DATABASE_URL`：被无条件检查中止（`config is missing, empty or unreadable`），两条恢复用例失败。
  - 空 env / 真实哨兵用例：行为本来正确，仅提示文案与预期不符（`config is missing...` vs `config is empty or unreadable`）。
  - 第一个 `run_*` 搬运失败：旧目录未回到原路径（`ENOENT`），holding 残留。
  - 第二个 `run_*` 搬运失败：第一个已搬入的 `run_*` 留在新建目录，回滚后原路径 `ENOENT`。

**绿（上一轮修复后）**

- `pnpm exec vitest run packages/worker/test/backup-script.test.ts` → **1 file / 41 tests passed，0 skipped / 0 failed**（最终一轮 71.41s）。含全部既有 restore 用例。
- `bash -n scripts/restore.sh && bash -n scripts/backup-lib.sh && bash -n scripts/backup.sh` → OK。
- `pnpm exec biome check packages/worker/test/backup-script.test.ts` → exit 0；5 warnings，均为同一规则（shell `${VAR}` 字符串），其中 4 处既有、新增 1 处（第二个 `run_*` 失败注入）沿用同写法。
- `git diff --check -- scripts/restore.sh scripts/backup-lib.sh packages/worker/test/backup-script.test.ts` → exit 0。

**本轮限定修复（引号往返）**

- 红：`pnpm exec vitest run packages/worker/test/backup-script.test.ts -t "exact quoted DATABASE_URL"` → 1 file，**1 failed / 41 skipped（共 42）**。失败差异为读回 `postgres://u:p'\''ass …` 而非原 URL `postgres://u:p'ass …`，与「只去首尾引号、未反解序列」一致。
- 绿：同一筛选 → **1 passed / 41 skipped**；完整 `pnpm exec vitest run packages/worker/test/backup-script.test.ts` → **1 file / 42 tests passed，0 skipped / 0 failed**（75.47s）。
- `bash -n scripts/restore.sh && bash -n scripts/backup.sh && bash -n scripts/backup-lib.sh` → OK。
- `./node_modules/.bin/biome check packages/worker/test/backup-script.test.ts` → exit 0；5 warnings，全部为既有 shell `${VAR}` 字符串规则（4 处上一轮已有 + 1 处上一轮新增），本轮新增用例无 warning。
- `git diff --check -- scripts/restore.sh scripts/backup.sh packages/worker/test/backup-script.test.ts` → exit 0。
- 模拟范围：本轮新用例仍用临时目录 + stub 的 `pg_dump`/`pg_restore`/`psql`/`pnpm`，通过记录 `--dbname` 与 `pg_dump` 参数断言目标字节；不连接真实库，也不需要密码本身含引号的真实账户。其余 41 个用例的模拟/真实范围与上方一致（仅哨兵用例使用本轮隔离随机库）。
- 最终验收：Opus `a3d703` 通过（含最后 URL 反解复核；前轮缺 env/坏配置中止与 `run_*` 归位修复同轮通过）。主会话 `byw28qy0g` 完整 `backup-script.test.ts` 42 passed / 0 skipped / exit 0（原始输出 `rtk recall 278485a1b40f3648`）；`bash -n scripts/restore.sh scripts/backup.sh scripts/backup-lib.sh` 与对应 `git diff --check` 通过。
- 本轮没有重跑真实 PG 演练：前两项已有真实演练证据，本项只改读取逻辑且有字节级单元往返，无新疑点。

**模拟 vs 真实范围（单元测试）**

- 41 个用例（含本轮新增 1 个）只用临时目录 + stub 的 `pg_dump` / `pg_restore` / `psql` / `pnpm`，不连真实库。
- 1 个哨兵用例使用 backend globalSetup 的本轮随机库（`backend_test_<随机>`），在库内自建/使用 `restore_sentinel` 表，验证空配置中止时哨兵行仍存在且没有 `pg_restore --dbname` 调用；本轮实际执行，未 skip。
- 特殊字符 quoting 的实际覆盖：`writes a source-safe bootstrap env` 证明引导 env 被 shell `source` 后与原文一致且未触发 `$(touch …)`；随后补上用 stub 参数对单引号/空格/`&`/`$(touch …)` URL 做逐字节往返，并由独立 Opus 在 `/bin/bash` 两端各 782 组合验证。无引号 URL 的崩溃恢复用例走过脚本读回；特殊字符 URL 未经真实账户连接，见下方限制。

**真实 PG 演练（独立临时脚本 `.tmp/codebase-review-restore/pg-drill.sh`，未新增重量测试框架）**

- 环境：宿主无 `psql`/`pg_dump`/`pg_restore`；已运行的 `agentport-postgres-1`（PostgreSQL 18.6，与镜像内客户端同版本）承担真实 `pg_dump`/`pg_restore`/`psql`。脚本据此走 `PG_CLIENT=auto` 的容器分支。连接串为 `postgres://agentport:<容器内密码>@127.0.0.1:5432/drill_restore_<时间戳>_<随机>`，密码只在脚本内从容器环境读取，不打印；所有输出中的 `postgres://…` 一律脱敏。
- 隔离：只新建并最终删除自己的随机库 `drill_restore_*`；`BACKUP_WORKSPACES_DIR`、`BACKUP_KNOWLEDGE_DIR`、`BACKUP_DIR` 全部指向本轮唯一 `mktemp -d`；未读写主 `.env`、共享工作区、共享知识卷或默认 `agentport` 库；未执行 `compose down`/reset。
- 流程与实测结果（`.tmp/codebase-review-restore/pg-drill-evidence.log`）：
  1. 备份真实随机库 + 临时工作区成功；备份日志无 URL（`url-in-logs=0`）。
  2. 改哨兵 `original` → `modified`，改工作区持久文件并新增 `run_live01/extra.txt`。
  3. `BACKUP_ENV_FILE=<不存在的路径>` + 显式 `DATABASE_URL` 恢复成功（无本地 env 的灾难恢复）；哨兵回到 `original`，持久文件回到备份内容，`run_live01` 两个文件保留，工作区无 `.restore-*` 残留；恢复日志无 URL。
  4. 安全包 `pre-restore-20261029-220439.tar.gz` 非空（206 bytes env），env 只有说明行 + `DATABASE_URL`，无其他密钥。
  5. 用该安全包回退（`DATABASE_URL=''`，目标库从安全包 env 读回）成功；哨兵回到 `modified`（第一次恢复前状态），工作区回到 `# changed` 且 `run_*` 保留；日志无 URL。
  6. 两次恢复都实际执行了恢复命令传入的 `--clean --if-exists --single-transaction` 与宿主 `pnpm db:migrate`。
- 清理证据：脚本 `trap` 只按自己的库名删除。运行后 `select datname from pg_database where datname like 'drill_restore_%'` 无结果；`/var/folders/…/T/pg-drill.*` 无残留；临时目录已删除（`temp dir removed=yes`）。第一次尝试因容器 exec 用户为 root 失败，未建库、未写数据，临时目录同样已清理。
- 限制：容器内 dev 密码只含字母数字，因此真实演练没有让密码本身触发 shell quoting。含单引号/空格/`&`/`$(touch …)` 的 URL 只用 stub 参数做逐字节往返（记录 `pg_restore --dbname` 参数），并由独立 Opus 在 `/bin/bash` 两端各 782 组合验证；没有真实密码含特殊字符的账户连接，stub 结果不冒充真实 PG 恢复。真实演练使用 TCP 连接（宿主迁移步骤需要），未覆盖 socket/容器内主机名场景；该场景由既有 compose-volume 用例覆盖。

**文档/脚本契约核对**

- `docs/OPERATIONS.md` §3.2 已同步：安全副本要求可恢复配置；本地配置不存在但显式 `DATABASE_URL` 时生成最小引导配置，现存空/不可读/复制失败时在改库前中止；安全包共用 `validate_archive`；文件换入只做尽力回滚，不承诺所有失败自动回原状。
- `docs/OPERATIONS.md` §3.1/§3.2 的 `run_*` 契约未变：备份排除、恢复保留现有 `run_*`；本次补上「当前专家不在备份中」的分支、部分搬运失败完整归位与保留 holding 的行为，§3.4 已记录真实 PG 演练及 stub 覆盖界限。

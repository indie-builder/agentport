# visual-check 截图工具

## 目标
把「开发完后生成 UI 截图看效果」这套流程固化成可一句话触发的工具。用户说「生成截图 / 看一下效果 / 截个图」即可产出目标路由在多个视口下的真实渲染截图并自动打开。
验收：一条命令能起隔离环境→登录→截图→打开→清理；不在真实开发库写数据；无新增运行时依赖。

## 方案
- `scripts/visual-shots.mjs`：确定性胶水。默认隔离临时库（建库→迁移→起 API/Web→健康→登录→可选最小种子→多视口截图→打开→清理）；`--base-url` 可复用已有栈。
- `.claude/skills/visual-check/SKILL.md`：项目自有技能，登记触发词与流程（非上游 vendored）。
- `docs/SKILLS.md` 登记为「项目自研」；`.gitignore` 忽略 `.visual/`。
- 复用：`ego-browser`（浏览器/截图/登录）、docker postgres、pnpm、根 `.env` 的管理员凭据；不新增依赖。

## 基线与范围
- 起始 commit：`6f54d5b`（= origin/main）。
- 允许改动：`scripts/visual-shots.mjs`、`.claude/skills/visual-check/SKILL.md`、`docs/SKILLS.md`、`.gitignore`、本任务记录。不动业务代码。

## 当前有效决定
- 默认隔离临时库（可靠、不碰真实数据）；复用现有栈用 `--base-url`。
- 数据种子默认 minimal（少量 agent + 1 频道，经登录态 fetch 造），可选 `none` / `dev-data`。
- 默认视口 1440x900、1200x900；输出 `.visual/<ts>/` 并自动打开；`--keep` 保留现场调试。

## 已替代项及原因
- 初期设想过「默认复用正在运行的栈」，因端口/来源/登录态不稳定，改为默认隔离临时库，`--base-url` 显式复用更可靠。

## 步骤
- [x] 实现 visual-shots.mjs（up/health/login/seed/screenshot/open/cleanup）
- [x] 写 visual-check 技能与 docs 登记、.gitignore
- [x] 端到端自测：跑一条命令产出真实截图并清理干净

## 改动文件
- `scripts/visual-shots.mjs`：CLI 实现（隔离建库/迁移/起服务/登录/种子/截图/打开/清理，`--keep` 与 `--base-url`）
- `.claude/skills/visual-check/SKILL.md`：项目自研技能（真实目录，非符号链接）
- `docs/SKILLS.md`：「项目自研技能」条目，说明不在 `skills-lock.json`、非上游 vendored
- `.gitignore`：忽略 `.visual/`
- `package.json`：新增 `visual:shots` 脚本

## 下一步
- 自测通过，未提交；等用户授权后再 commit。

## 验证
- 命令：`node scripts/visual-shots.mjs --route /agents --viewports 1440x900 --out .visual/selftest --no-open`
- 结果：退出码 0；产出 `.visual/selftest/agents-1440x900.png`（84.0K），截图为 /agents 页且含 minimal 种子（2 个 agent）。
- 清理：`lsof -tiTCP:3000 -sTCP:LISTEN` 与 `lsof -tiTCP:5173 -sTCP:LISTEN` 均无输出；
  `select datname from pg_database where datname like 'pace_visual_%'` 为空。
- 附加验证：`--keep` 保留服务与临时库（随后手动清理）；`--base-url http://localhost:5173 --seed none`
  复用已有栈、不启停服务，退出码 0。
- 自测中修复：`waitForFunction` 的期望路径需要作为第二个参数传入；ego-browser 把脚本输出写到 stderr，需合并解析。

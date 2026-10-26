# 多模态处理修复定点复核

2026-10-26；当前 worktree，仅源码复核；未派代理、未修改产品、未提交。
范围：原 processing 评审 1 取消、2 profile 空间、3 降级恢复；图片校验仅补充核对。
未运行 DB 测试，不将主会话已在隔离库执行的结果冒充本轮实测。

## 1 取消：REOPEN（P1，最小阻塞项）

- 已补：`packages/worker/src/knowledge/ingestion.ts:628`、`:649` 在插 chunks 前和切版前检查 abort，`:650` 将 signal 回调交给事务。
- 仍漏：`packages/db/src/repo/knowledge.ts:528` 只在事务开始检查一次 `guard.isAborted`；`:529`、`:535` 两次 await 后，`:554` 直接更新 currentVersionId。
- 具体触发：事务入口 signal=false，读取 job/base 期间 Redis 取消监听触发 abort；运行中 job 仍 running，库仍 active，故所有 DB 守卫通过，已取消任务仍发布新版本。
- 取消机制依据：`packages/worker/src/knowledge/queue.ts:151` 轮询 Redis 后 abort；此时不更新 job 行，不能用 running 判定替代 signal。
- 最小修法：在事务最后一次读取/配置检查之后、`:554` 更新之前再检查 `guard.isAborted?.()` 并返回 null；无需新增锁或扩展理论竞态方案。
- 测试：`packages/worker/test/knowledge-ingestion.test.ts:325` 在 insert 时 abort，证明切版事务之前的检查；未覆盖事务 SELECT 的 await 期间 abort。补该位置注入取消并断言旧 currentVersionId 保留即可。

## 2 profile 空间：CLOSED（源码与测试覆盖）

- `packages/worker/src/knowledge/ingestion.ts:741` 读取当前版本，`:743` 比较版本与库 profile，不一致即抛 KnowledgeProfileMismatch，发生在创建 embedding client 和补写前。
- `packages/worker/src/knowledge/ingestion.ts:848` 将该错误向外抛出，避免整库重建吞掉失败。
- `packages/worker/test/knowledge-ingestion.test.ts:867` 覆盖 A 版本切同维 B 后 chunksOnly 拒绝，`:900` 断言缺失向量仍为 null；本项未见需重开的问题。

## 3 降级恢复：CLOSED（源码与测试覆盖）

- `packages/worker/src/knowledge/ingestion.ts:489` 图片向量失败仍追加 vector 草稿，保留描述/metadata、searchText 空、embedding null；`:576` 按 imageRole 排除文字 embedding。
- `packages/worker/src/knowledge/ingestion.ts:772` 补缺失任务识别 vector，`:781` 从版本图片清单取 MIME/原图，调用图片 embedding 后补写。
- `packages/worker/test/knowledge-ingestion.test.ts:676` 从实际 429 降级产物开始，断言 OCR/caption 有向量、vector 为 null 且未混入 texts；恢复上游后断言 vector 1024 维、发出 images 请求且视觉调用次数不增。

## 图片校验补充（最终收口仍归图片评审 owner）

- `packages/worker/src/knowledge/image-processing.ts:43` 检查 5MiB，`:48` 使用 sharp.raw().toBuffer() 实际解码并限制像素，`:54` 补 PNG IEND 检查；`:215` 在视觉调用前复用校验。
- SDK helper 仍保留：`packages/worker/src/knowledge/image-processing.ts:75` 的 runAction 与 `:205` 的 describeKnowledgeImage；本轮未重新验 SDK 官方行为或真实模型效果。
- `packages/worker/src/knowledge/parsing.ts:781` 独立图片入口调用校验；`packages/worker/test/knowledge-parsing.test.ts:219` 已替换完整 JPEG/GIF/WebP fixture，`:260` 覆盖截断拒绝。
- `packages/worker/test/knowledge-image-processing.test.ts:73` 覆盖四格式完整图；`:216`、`:232` 覆盖截断/超过 5MiB 且模型调用为零。这里只确认源码及断言接线，不宣称本轮测试通过。

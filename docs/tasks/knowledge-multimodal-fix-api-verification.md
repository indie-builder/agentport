# 多模态 API 定点整改核验

范围：原审查 1–4、vector chunk PATCH；当前 worktree，直接读源码与断言，无代理、无产品修改。
判定：confirmedfixed 表示指定 API 源码缺口已补；qualified 表示证明范围有限；不代替运行通过。

- confirmedfixed｜1 API 包产物：不再过滤 vector chunk；保留 content、enabled、metadata，省略 embedding。证据 packages/api/src/features/knowledge/package.ts:409、:464、:469、:470、:475。
- confirmedfixed｜1 导入接口：vector 的 searchText=''，所有 embedding=null，保留 metadata/启停/描述。证据 packages/api/src/features/knowledge/package.ts:834、:836、:838、:839、:844。
- qualified｜1 测试证明范围：packages/api/test/knowledge-multimodal.test.ts:949、:969、:983、:985、:987 断言导出/导入角色、原图 name、空 search_text、null embedding；未断言描述/停用状态往返，未执行 chunksOnly，不证明实际回填成功。worker 回填由另一 owner 负责，本次仅确认所需产物与接口。
- confirmedfixed｜2 停库：公共 searchKnowledge 在任何检索前拒绝非 active，抛 CONFLICT。证据 packages/api/src/features/knowledge/retrieval.ts:207、:210。
- qualified｜2 断言不足：新增文件的检索组 packages/api/test/knowledge-multimodal.test.ts:487 至 :669 未覆盖停库 REST 搜索拒绝；:773、:804 测的是 readKnowledgeImage 的 BASE_DISABLED，不能证明管理检索 API 拒绝。
- confirmedfixed｜3 metadata：任一 image/imageRole 保留键触发完整 schema 校验，要求 kind=image，并核对版本图片清单、MIME、page。证据 packages/api/src/features/knowledge/package.ts:1059、:1062、:1070、:1078、:1082、:1085。
- qualified｜3 测试证明范围：packages/api/test/knowledge-multimodal.test.ts:994、:1030、:1041、:1055 覆盖角色缺图、text 携图片 metadata、页码错配的 INVALID_INPUT；:1058 覆盖越界图片名。未见独立 MIME 错配、仅 image 缺角色样例；不能声称所有关系分支已实测。
- confirmedfixed｜4 profile PATCH：换绑时要求 embedding 类型且 enabled；未换绑仍允许维护已绑定停用 profile 的库。证据 packages/api/src/features/knowledge/routes.ts:560、:561、:564。
- qualified｜4 断言充分但未执行：packages/api/test/knowledge-multimodal.test.ts:262、:291、:303、:311 覆盖 rerank/停用 embedding 换绑返回400及绑定不变；:316、:330 验证停用后不换绑仍可维护。不能把未运行断言当作通过。
- confirmedfixed｜vector PATCH：合法 vector metadata 的 content 或 heading 修改在写库前返回409；enabled 可独立修改。证据 packages/api/src/features/knowledge/routes.ts:973、:976、:977、:979、:983。
- qualified｜vector PATCH 断言：packages/api/test/knowledge-multimodal.test.ts:339、:417、:433、:444、:448 覆盖编辑拒绝、metadata 不被替换、停用成功及原内容保留；本次未运行到断言。

执行：`node .tmp/knowledge-multimodal-run.mjs pnpm exec vitest run packages/api/test/knowledge-multimodal.test.ts --project backend --reporter=dot --maxWorkers=1`。
实测：Test Files 1 passed，Tests 18 passed（1.77s）。早前裸跑退出1、Tests no tests 是未加载隔离环境变量导致，补跑后全部通过。
本次补测（只改测试，不改产品）：
- 停库 REST 检索：`rejects REST search on a disabled base with 409` 先验证 active 返回 200，再置 `status='disabled'` 断言 GET `/api/knowledge/bases/:id/search` 返回 409 且消息含「禁用」；补上原 :10 缺口。
- ZIP 真实 chunksOnly 回填：`refills the imported vector chunk via chunksOnly without running image description` 走真实导出→导入→`runReindex(chunksOnly)`，`imageQueryFn` 与 `decrypt` 设为抛错以证明未生成描述/未解密；断言描述 chunk 有向量、vector chunk 以原图字节回填 1024 维（fixture 图片向量首维 0.01，区别于文字 1）、`search_text=''`、`metadata.image.name='fig-1.png'`。
- 扩大既有 ZIP 测试：导入导出往返同时断言 vector 停用状态（enabled=false）保留；fixture seed 加 `imageVectorEnabled` 开关，默认行为不变。
未复核 worker chunksOnly 实现及 Web 错误 owner 改动；真实 SDK HTTP MCP image→model 已由主会话验证，不列为阻塞，不承诺真实模型检索质量。
唯一写入本文件，未提交、未合入。

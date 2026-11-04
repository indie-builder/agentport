---
extends: shipping
when: 在本仓库合入已验证的 PR 或处理落栈时。
---

# Shipping 项目适配

- **In** "Landing needs the user's landing authority, and each landing is confirmed before the next starts." 一次明确的合并请求只授权其指定的 PR 或链，不逐个重复询问；每个 PR 仍逐个执行并读回实际状态。
- **In** "Resolve the forge, then verify each PR independently before it lands." 保留独立审查与真实验证：由未写该代码的代理按用户方式验证；只有获授权才把 verdict 发到 PR，否则在本地记录。
- **In** "Merge it once its checks pass and its verdict survives." 按项目本地验证加独立 Opus 终审有效后执行已授权合并，不等待 CI；保留原 head 条件、目标确认与合并结果读回。
- **Replace** "Leave the stack alone while it lands." 普通合并不运行 watcher、loop 或 CI 等待；只有用户明确要求监控时才启用对应 watcher，监控范围仍受本任务授权约束。保留 step 4 的链顺序、retarget/replay、lease 与 pending 取消等状态安全步骤；合并停滞先查原因。
- **In** "Always merge the run's lowest unmerged PR under a service-enforced head condition" 保留真正的合并前 head 条件与合并后状态读回；跳过 CI 等待不等于跳过这两项确认。

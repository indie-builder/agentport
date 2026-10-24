# 侧栏画布渐变底色

## 目标
参考用户提供的截图，给应用侧栏区域加一层极低饱和的竖向冷暖渐变底色，
让左侧导航更有呼吸感；主区（卡片、正文）仍保持无彩度。

## 方案
- 不改成逐组件的侧栏背景，而是给「页面画布层」加一条竖向线性渐变，
  侧栏透明、自然透出；白壳继续完全覆盖主区，正文对比度不受影响。
- 颜色取自参考截图实测像素：顶淡暖 → 中段中性 → 底淡冷，压到很浅的一档。
- 通过 `--canvas-wash` 令牌统一控制，色标可单点微调。

## 步骤
- [x] 新增 `--canvas-wash` 令牌与 `.app-canvas-wash` 类
- [x] 应用外壳、加载骨架、登录校验失败态改用 `app-canvas-wash`
- [x] 登录页画布同步
- [x] 同步 `docs/DESIGN-SYSTEM.md` §2 / §7

## 改动文件
- `packages/web/src/styles.css`
- `packages/web/src/components/app-shell.tsx`
- `packages/web/src/pages/login.tsx`
- `docs/DESIGN-SYSTEM.md`

## 下一步
无

## 验证
- `pnpm --filter @agentport/web typecheck` → 通过（exit 0）
- 浏览器实测展开/收起两种侧栏状态，采样渐变端点色：
  顶 `rgb(246 246 231)`、中 `rgb(241 242 237)`、底 `rgb(236 239 241)`
- `biome check` 对两个 tsx 无告警（CSS 不在其扫描范围）

# 聊天附件真实隔离验收

2026-10-28。环境为独立 PostgreSQL 库、独享 Redis 容器、随机 API/模型代理端口、独立 workspaces 与随机管理员；未使用共享服务或用户现有登录。模型 `group/flash`，沙盒镜像含新增的 Poppler。原始运行日志见 [api-run.txt](api-run.txt)。

## 通过项

- 随消息上传 CSV、PNG、14 页 PDF；会话详情保留 3 个附件元数据，队列不含文件字节。
- 第一轮真实模型对三个 `/mnt/inputs/<uuid>.<ext>` 均发出原生 `Read`；生成的 `report.md` 含 CSV 华东数值 128、图片页面品牌 PACE、PDF 末页唯一串“海燕-42”，正文/下载/磁盘 sha256 一致。
- 三个附件下载均 200，sha256 与夹具一致：
  - `data.csv` `6fce2f15fdca0b86270b4faf6780cdaa551fb360b05f89ed9e2e30a7dd8e84a8`
  - `login.png` `3920b650b3d9592a390d4624c7647f53fd383b4292873eab2927597c6f005b79`
  - `long.pdf` `5f6dbc87ae7a1f2198c78f4f37a718a6d8d6262cd2c223c7c08bb15fbeffa9a4`
- 第二轮在同一会话重新 `Read` 历史 CSV 路径并生成 `second.md`，证明历史附件路径跨 run 仍有效。
- 按历史点分支后删除源会话：分支附件下载 200 且内容一致；分支续聊再次读取原附件并生成 `branch.md`（见 [branch.md](branch.md)，其中记录华东=128）。
- 跨会话下载附件 404；伪造 PNG 签名与超限文件均 400。
- 桌面浏览器（[browser.md](browser.md)）：真实文件选择、空正文仅附件可发送、用户消息附件标签与下载、运行期禁用、刷新后标签/下载/成果仍在全部通过；下载 `data.csv` 字节哈希与夹具一致。唯一偏差是模型把风格化 `PACE` 品牌读成 `FACE`，属视觉识别质量，不是附件串包或链路失败。

运行标识：主会话 `conv_01m619czwwenatec6mxd7wdp9t` / `run_01m619czx1enatec6vgmk17svs`；第二轮 `run_01m619f443enatec7gxgjm6dxf`；分支 `conv_01m619fd72enatec8b1bbcq6jy` / `run_01m619fd85enatec9f75c7vmb5`。

## 证据与限制

- 源会话在分支验证中按要求删除，因此 `report.md` / `second.md` 原件不保留；其内容与哈希由脚本在删除前逐项校验并记录在 [api-run.txt](api-run.txt)，不伪造留存副本。
- 夹具 `long.pdf` 由脚本生成并内嵌字体，确保 Alpine Poppler 可渲染末页；生成器与文件保留在临时验收目录，不进入产品依赖。
- 浏览器上传/下载/刷新由 [browser.md](browser.md) 单独记录。
- 未覆盖：10MiB 合计上限的真实大请求压测、多文件同名、Office/ODF（明确不支持）、真实读屏与原生缩放。

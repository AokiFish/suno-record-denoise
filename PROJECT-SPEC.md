# Suno 录音降噪 — 独立项目规格（GitHub + Cloudflare Pages）

> 状态：2026-11-16 12:38 Luca 定：做成独立全栈项目，我推 GitHub，他在 Cloudflare 部署，绕开 Muse 空间 iframe 限制。
> 仓库名：`suno-record-denoise`（Luca 建库时可改，改了告诉我一声）。本地目录：`~/workspace/suno-record-denoise/`。

## 1. 目标（具体）

一个独立仓库、部署在 Cloudflare Pages 上的顶层网页应用：Luca 在桌面 Chrome 里打开它，点录制，分享 Suno 标签页并勾选“共享标签页音频”，直接录下自己 Suno 歌的数字原声；录完在页内降噪（只去稳态杂音）、同响度 A/B 对比、导出干净 WAV，再手动上传 Audio Lab 做增效。首版不依赖任何服务端：录音与降噪全在浏览器本地，录音库放 IndexedDB。

## 2. 已核验事实原文

- 录制死结（2026-11-16 12:34，C-Audio-lab 已查明并修完，记入 MEMORY.md）：“空间跑在 Muse 的 iframe 里，容器没给 iframe 加 `display-capture` 权限，桌面 Chrome 在这个框里根本不暴露标签页捕获的接口。所以你点‘开始录制’连选择器都弹不出来。” 换桌面浏览器也没用，只有容器放行或脱离 iframe 才能录。顶层页（非 iframe）中 `getDisplayMedia` 是桌面 Chrome 的标准能力：分享弹窗选“Chrome 标签页”后左下角出现“共享标签页音频”，勾上即有声音；选“整个屏幕/窗口”则没有音频。
- 录音降噪空间 v1（slug `lu-yin-jiang-zao-kong-jian`，2026-11-16 12:11 建成）：网页播放录制、麦克风、上传三入口；谱减法降噪 + 90 Hz 高通 + 同响度 A/B + 指标 + 导出 WAV。沙盒核验：5 个 action 通、`listRecordings` 实读为空库。DSP 数字为 builder 沙盒数（噪声底 -52→-69 dB），未独立复核。真机标签页抓取与麦克风录音未验。
- Suno 下载额度（Luca 2026-11-16 12:37 亲口说“下载不了，我没有积分了”）：2026-11-15 核实免费号终身 7 次、已用 5 次剩 2 次；现在以 Luca 说的“没有积分”为准，不再争 2 次旧数。下载路线目前不可用，录制是唯一拿歌路线。
- Audio Lab（`~/workspace/audio-lab`，M0–M3 完成）：FastAPI + Vite React 本地 web 应用，Python + ffmpeg + pedalboard，不能原样跑在 Cloudflare Pages/Workers 上。本项目不复用 Audio Lab 后端；交接只靠一支干净 WAV 文件手动上传。
- GitHub（2026-11-16 12:38 实测 `github status`）：`auth_status: "connected"`，账号 AokiFish（`9b3a2b5f99794f9292f97199316f14ec`，default）。工具目录里有 `create_repository` 与 `push_files`。但 2026-11-12 实测：经 GitHub API 建库报 403（当时 Muse GitHub App 无建库权限），改走网页端；且 Luca 当时跳过了仓库选择（“以后需要再说”），App 看不到仓库就推不上去。结论：建库先试 API，403 就改 Luca 网页建空库 + 勾选授权，再推文件；推完必须回读核验。
- Cloudflare（Luca 记忆）：他很多项目部署在 Cloudflare，觉得有限制。Pages 是静态托管，`npm run build` → `dist` 即可；录音/降噪全在浏览器，不需要服务端算力，不碰 Workers CPU 限制与 Python/ffmpeg。

## 3. 来源

- `~/workspace/suno-record-denoise/SPACE-SPEC.md`（空间版规格：降噪做法、验收口径）
- `~/workspace/audio-lab/docs/01-product.md`、`docs/02-audio-quality.md`（A/B 同响度、G8 静音不放大、G2 无新增削波口径）
- MDN `getDisplayMedia` / `MediaRecorder`（工人动手前先读）
- Cloudflare Pages 文档（Workers/Pages 部署做法，工人先读官方文档再写配置）
- modern-web-guidance：`lazy-load-video-and-audio`、`accessibility`（已 retrieve）

## 4. 架构（定死，不许擅自换）

- 前端：TypeScript + React + Vite（版本贴 Audio Lab 已锁定的稳定线：React 19.3.1、Vite 7.3.8、TypeScript 5.9.3），纯 CSS（CSS 变量），不引入 UI 组件库。
- 录制：`getDisplayMedia({ video: true, audio: true })`，只取音频轨；`MediaRecorder`（WebM/Opus）→ 解码 → 转 WAV 入库。麦克风入口（`getUserMedia`，降噪/回声消除/自动增益三开关）与上传入口（wav/mp3/flac/m4a，≤80 MB/10 分钟）保留。
- 降噪：与空间版同一做法——FFT 谱减法/谱门（1–2 秒纯噪声段学生噪声谱，可手动框选或自动取最安静帧）+ 90 Hz 高通；强度滑块 0–100% 默认 50%，强度 0 = 原声（除高通外不引入处理，写明）。
- 对比与指标：同响度 A/B（切换播放位置不变，响度差 <0.2 LU，默认先播处理后）；显示噪声底、信噪比变化、频谱距离、真峰值、削波数；静音段处理后仍 <-50 dBFS（开头 100 ms 不计）。
- 导出：浏览器内编码 WAV（44.1 kHz）下载；附 denoise-report.json（噪声段位置、强度、SNR 前后、真峰值、警告）。
- 存储：首版 IndexedDB（录音 + 设置 + 指标），零服务端、零环境变量。Workers/R2 跨设备同步是第二步，不写进首版、不留假接口。
- 部署：Cloudflare Pages。`package.json` 有 `build`（`tsc && vite build`）与 `preview`；根目录 `README.md` 写清 Luca 的部署步骤（Cloudflare Dashboard → Pages → 连接 GitHub 仓 → 构建命令 `npm run build`、输出目录 `dist`）；不写需要他配 R2/KV/D1 的步骤。
- 文案：中文，克制（一个页面一个主要动作）；不出现 EQ、压缩、LUFS、dB 等术语（处理详情除外）；诚实边界写在页内：只对稳态杂音有效，突发声响去不干净、强度过高会伤音色。

## 5. 禁做清单

- 不许把 Muse 空间 iframe 里被拦的录制逻辑原样搬过来冒充“已修好”；顶层页必须实测 `getDisplayMedia` 存在才标可用，不可用时三态检测（可用/被拦/不支持）+ 禁用按钮 + 如实说明，旧“手机浏览器不支持”误报文案不许再出现。
- 不许做多轨、混音、人声分离、修削波、音色转换；不许自称“AI 降噪模型”/“RNNoise 已接入”，除非真接了对应模型并给出证据。
- 不许在前端做假处理（原样返回冒充降噪）；做不到写明做不到。
- 不许推 GitHub、不许动 Cloudflare（那是咪咪/指挥官的步骤，工人只做本地脚手架 + 验证）。
- 不许首屏全加载：视图分割（React.lazy + Suspense）、非首屏 `<audio>` 加 `loading="lazy"` + `controls` + `preload="metadata"`（`lazy-load-video-and-audio` 规则：“Lazy-loaded `<audio>` elements without `controls` are not rendered visibly and will never load or autoplay.”；Firefox/Safari 不支持该属性时靠 `preload` 兜底）；无外部字体 @import；列表查询按标签页门控。
- 不许编数字、编链接、编“已和 Audio Lab 打通”。

## 6. 机器可核验的验收标准

- [ ] `npm run build` 退出 0；`npm run preview` 首页 200；无控制台错误。
- [ ] 降噪 DSP 数值测试：粉红噪声 + 1 kHz 正弦合成音，强度 50% 时噪声频段能量下降 ≥6 dB，1 kHz 频段变化 <1 dB；强度 0 与原声频谱差 <0.3 dB（高通除外，写明）；无新增削波；静音段处理后仍 <-50 dBFS（开头 100 ms 不计）。
- [ ] A/B 同响度：两段实测响度差 <0.2 LU；切换播放位置不变。
- [ ] 录制三态检测代码存在：`getDisplayMedia` 不存在时按钮禁用 + 如实文案；存在时点录制弹出分享选择器（真机权限步骤留给 Luca，沙盒只验检测分支）。
- [ ] 上传入口：wav/mp3/flac/m4a 各 2 秒测试音均成功入库；改扩展名文本文件拒收；>80 MB 拒收。
- [ ] 导出 WAV：ffprobe 为 44.1 kHz，时长误差 ≤10 ms；denoise-report.json 字段齐全。
- [ ] README 部署步骤按字面可走：构建命令与输出目录与 `package.json` 一致；无未声明的环境变量。
- [ ] 懒加载：首屏音频总字节、JS 分块数、移动端 settle 时间实测记录；非首屏音频全 lazy；无外部字体。

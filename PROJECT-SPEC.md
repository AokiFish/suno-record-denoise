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
- 降噪（v2，2026-11-16 改）：FFmpeg `afftdn`（ffmpeg.wasm 单线程版，`@ffmpeg/ffmpeg@0.11.6` + `@ffmpeg/core@0.11.0`，钉死不升 0.12.x）+ 90 Hz 高通；滤镜串 `highpass=f=90,afftdn=nr=X:nf=Y`，强度滑块 0–100% 默认 50%（→ `nr=12:nf=-30`），强度 0 = 只做高通；不用 `sn` 采样（出货核心上不达标，见 §7），不框选噪声段；静音门默认关（开时只在全频段 RMS < −60 dBFS 的段动作，淡入淡出 50 ms）。v1 手写谱减法已删除，不留作备选；wasm 加载失败如实报错。
- 对比与指标：同响度 A/B（切换播放位置不变，响度差 <0.2 LU，默认先播处理后）；显示噪声底、信噪比变化、频谱距离、真峰值、削波数；静音段处理后仍 <-50 dBFS（开头 100 ms 不计）。
- 导出：浏览器内编码 WAV（44.1 kHz）下载；附 denoise-report.json（强度、SNR 前后、真峰值、警告）。
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

## 7. v2 引擎重做（2026-11-16，Luca 实测批评后）

**起因**：Luca 2026-11-16 13:12 批评——录音时低声部已卡顿（录制零处理，与降噪无关），降噪效果一般，质问是否没参考 GitHub 顶级实现、拿 demo 交差。属实：v1 降噪是现写的教科书谱减法（2048 FFT、硬 20 dB 下限、±2 bins 平滑、硬静音门），只在合成音上测过数，未照任何顶级实现移植；录制未设 `audioBitsPerSecond`、切后台会被 Chrome 节流。

**选型理由**：读过源码原文的三方参照——Audacity `NoiseReduction.cpp`（音乐几十年）、FFmpeg `afftdn`（`libavfilter/af_afftdn.c`，5.1 与 8.1 两版都读过、diff 过，增益与采样源码逻辑相同）、noisereduce（平稳谱门，论文 Sainburg 2024；读过源码用于理解参数映射）。神经音乐降噪论文有但无一是能装进浏览器的现成库 + 权重；能装的 RNNoise / DeepFilterNet 全是人声模型（DeepFilterNet 官方定位 speech enhancement；ZenTools FAQ：*"It is tuned for speech, so it treats instruments as noise."*），会吃乐器，不用。结论：浏览器里能落地的顶级方案是经典谱门做对，不是神经网络。

**被否掉的方案（都有实测数，见 PROGRESS.md）**：

- noisereduce 平稳谱门移植：原任务，后被 afftdn 方案取代（指挥官 2026-11-16 追加结论）。noisereduce 的阅读不白费：参数映射思路（阈值、软掩码、时频平滑）用于理解 afftdn 的 `nr`/`nf`。
- `sn` 噪声采样：出货核心（wasm 5.1 系）上采样链最好成绩 brilliance 只降 5.10 dB（`nf` 已到上限 −20），达不到 ≥6 dB 验收线；且采样把低频段推过线。采样谱形在 wasm 与 CLI 上完全不同（CLI 峰 +14 dB@270 Hz，wasm 高频段压到 −24 限幅），源码相同、构建层差异。改用默认白噪声谱形，不采样。
- LR4 分频（250 Hz 以下直通）：分频重构本身让低频段动 −2.40 dB，比不分频的 −0.62 dB 更差。低频保护改由 `nf=−30` 上限保证。
- `bn` 自定义低频保护：采样会覆盖 `bn`（源码 `set_noise_profile` 直接 memcpy）；在不采样链上 `bn` 与默认谱形结果完全相同（冗余）。
- 0.12.x 多线程 wasm core：任务钉死 0.11.6/0.11.0，勿升；多线程要 SharedArrayBuffer + COOP/COEP，单线程不用。

**录制修复**：`MediaRecorder` 加 `audioBitsPerSecond: 192000`；页面加前台警告（Suno 标签页与本站标签页都要保持前台，切后台会被 Chrome 节流造成断点）；录音元数据记 chunk 数与总字节数（250 ms 一 chunk，60 秒应有约 240 个，供断点定位）；timeslice 保持 250 ms。

**v2 验收（替代 §6 第 2 条的合成音引擎测试）**：真歌 fixture（贝多芬《月光奏鸣曲》第一乐章，Wikimedia Commons CC BY-SA 4.0，42 秒，加粉红噪声至 20.00 dB SNR）双线实测——CLI ffmpeg 8.1 与 wasm 核心出货链（`highpass=f=90,afftdn=nr=12:nf=-30`）都通过：噪声频段（brillance 5–10 kHz）降 ≥6 dB、低频段（20–250 Hz 合并绝对电平）变化 <1 dB、中频段（500–2000 Hz）变化 <1 dB、无新增削波、静音段 <−50 dBFS。完整指标表见 PROGRESS.md。合成音测试保留为测量辅助与静音门测试（`tests/dsp.test.ts`，18/18 通过）；原验收里的“掩码平滑测试（相邻帧掩码变化有界）”不适用——afftdn 的掩码/平滑在 libavfilter 内部，没有 JS 掩码可测，改为滤镜串构造测试（锚点、插值、不含 `sn` 采样断言）+ 真歌双线指标表。

**已知偏差（报给父代理）**：同一份 afftdn 源码在 wasm 核心与本机 ffmpeg 8.1 上 `nf` 标定差约 20 dB（wasm `nf=−30` ≈ CLI `nf=−50`），出货链在 wasm 核心上标定、CLI 只作交叉对照；“本机真 ffmpeg（同款 libavfilter 代码）先验证”的前提在实践中不成立，验收数字以 wasm 线为准。低频段验收口径为 20–250 Hz 合并绝对电平（90 Hz 高通单独就让 sub 20–60 Hz 相对电平动 −15.66 dB，sub 单独算永远过不了线，见 PROGRESS.md）。

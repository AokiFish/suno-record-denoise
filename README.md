# 录音降噪 · Suno

录下自己 Suno 歌的标签页音频，去掉稳态杂音，导出干净 WAV，再送 Audio Lab 做增效。

本项目是 [Audio Lab](https://github.com/AokiFish/audio-lab) 的前置工序：Audio Lab 只做增效、明确不做降噪；这里只做录制 + 降噪，不做增效。

## 做法（诚实说明）

- **录制**：顶层页面用 `getDisplayMedia` 抓标签页音频（Chrome / Edge 桌面版），或麦克风录音，或上传已下载的音频文件。音频只在你的浏览器里处理，不上传到任何服务器。录制用 192 kbps（`audioBitsPerSecond: 192000`）；录制时 Suno 标签页与本站标签页都要保持在前台，切后台会被 Chrome 节流、录音断点。
- **降噪**：FFmpeg `afftdn`（ffmpeg.wasm 单线程版，见下“引擎选型”）+ 90 Hz 高通 + 静音门（默认关）。不是 AI 模型、不做人声分离、不修削波，只压稳态杂音。
- **对照**：原声 / 降噪后同响度 A/B，切换时播放位置不变。
- **导出**：浏览器内编码 16-bit PCM WAV（44.1 kHz），附 `denoise-report.json`（指标 + 警告）。

## 使用

1. 在 Suno 网页打开要录的歌（单独一个标签页）。
2. 打开本站 → **录制** → **录制标签页音频** → 在弹出的选择器里选那个 Suno 标签页，并**勾选左下角「共享标签页音频」**（不勾录出来是静音）。点分享后切回 Suno 点播放，录完点停止。
3. 录音进库后打开 **降噪工作台**：调强度（默认 50%），试听 A/B，导出 WAV。首次打开工作台时加载降噪引擎（约 25 MB，之后缓存），加载失败会如实报错，不会悄悄切回旧引擎。

另外两条路：**麦克风录音**（降噪 / 回声消除 / 自动增益三个开关可勾），**上传文件**（wav / mp3 / flac / m4a，≤ 80 MB、≤ 10 分钟）。

### 录不了？先看状态

页面会直接告诉你当前状态，三种之一：

- **可以录制**——顶层页面，`getDisplayMedia` 可用。
- **被容器拦截**——页面跑在 iframe 里、容器没给 `display-capture` 权限，浏览器根本不暴露标签页捕获接口。换浏览器也没用，只有脱离 iframe（独立部署本站）才能录。这是 Muse 空间版做不到、所以才有这个独立项目的原因。
- **浏览器不支持**——Firefox / Safari 不带标签页音频，移动浏览器不支持标签页捕获。请用桌面 Chrome / Edge。

## 引擎选型（v2，2026-11-16）

v1 的手写教科书谱减法已被删除（Luca 实测批评：降噪效果一般、且未照任何顶级实现移植）。v2 引擎 = **FFmpeg `afftdn`**（`libavfilter/af_afftdn.c`，2018 年加入 FFmpeg 的 FFT 降噪滤镜），经 ffmpeg.wasm 单线程版（`@ffmpeg/ffmpeg@0.11.6` + `@ffmpeg/core@0.11.0`，钉死不升 0.12.x）在浏览器里跑；单线程 core 不用 SharedArrayBuffer / COOP / COEP，纯静态托管就能跑，Cloudflare Pages 不用改任何配置。滤镜串：`highpass=f=90,afftdn=nr=X:nf=Y`，强度滑块映射到 `nr`/`nf`（默认 50% → `nr=12:nf=-30`；完整映射表与实测数见 `PROGRESS.md`）。

参照来源（都读过源码原文，不是凭印象）：

- FFmpeg afftdn：`libavfilter/af_afftdn.c`（5.1 与 8.1 两版都读过、diff 过）——`nr`（0.01–97 dB，默认 12）、`nf`（−80 至 −20，默认 −50）、`sn start/stop` 噪声采样、15 段自定义 `bn`。
- Audacity Noise Reduction（`audacity/audacity`，`src/effects/NoiseReduction.cpp`，GPL v2）：音乐用了几十年的算法，两遍做法——先过一遍纯噪声统计各频带，再按频带给增益、时域平滑 + 频域平滑、Hanning 窗 + overlap/add。
- noisereduce（`timsainb/noisereduce`，论文 Sainburg 2024）：平稳谱门明确基于 Audacity 的做法；本项目读过它的源码用于理解参数映射，但交付引擎是 afftdn，不是它的移植。

**为什么不用神经网络降噪**：神经音乐降噪论文有（SonicMaster arXiv:2508.03448、ADNAC arXiv:2511.01773、SimAM-UNet、MusicECAN、Diffusion-Based Denoising of Historical Recordings），但没有一个是能直接装进浏览器的现成库 + 权重；能装的 RNNoise / DeepFilterNet 全是人声模型——DeepFilterNet 官方定位就是 speech enhancement，ZenTools FAQ 原文：*"It is tuned for speech, so it treats instruments as noise."* 会把乐器当噪声吃掉，音乐降噪不能用。所以浏览器里能落地的顶级方案是经典谱门做对，不是神经网络。

**两个实测后否掉的做法**（数字见 `PROGRESS.md`，不是凭感觉）：

- `sn` 噪声采样：出货核心（wasm 5.1 系）上采样链最好成绩 brilliance 只降 5.10 dB（`nf` 已到上限 −20），达不到 ≥6 dB 验收线；且采样会把低频段推过线。出货链改用默认白噪声谱形，不采样——工作台不再框选噪声段。
- 250 Hz 以下分频直通（LR4）：分频重构本身让低频段动 −2.40 dB，比不分频的 −0.62 dB 更差。低频保护改由 `nf=−30` 上限保证。

另：同一份 afftdn 源码在 wasm 核心与本机 ffmpeg 8.1 上 `nf` 标定差约 20 dB（wasm `nf=−30` ≈ CLI `nf=−50` 的效果），所以出货链在 wasm 核心上标定，CLI 只作交叉对照；真歌验收在双核心上都通过（见 `PROGRESS.md` 指标表）。

## 本地开发

要求 Node.js 18+（实测 Node v24.22.1、npm 10.9.4）。

```bash
npm install --legacy-peer-deps   # 注意：plain npm install 会在依赖解析时崩溃（npm arborist edgesOut 报错），--legacy-peer-deps 是已验证的绕法
npm run dev        # 开发服务器
npm run build      # 类型检查 + 生产构建，产物在 dist/
npm run preview    # 本地预览生产构建
npm test           # vitest run，DSP 数值测试
npm run check      # tsc --noEmit && npm test && npm run build
```

## 部署到 Cloudflare Pages

零服务端、零环境变量、零 R2 / KV / D1。按 Cloudflare Pages 官方文档的 Git 集成流程：

1. 把本仓库推到 GitHub（分支 `main`）。
2. Cloudflare Dashboard → Workers & Pages → Create application → Pages → Connect to Git → 选这个仓库。
3. 生产分支填 `main`；Framework preset 选 Vite（或直接填下面两项）：
   - **Build command：`npm run build`**
   - **Build output directory：`dist`**
4. Save and Deploy。之后每次推 `main` 自动重建，地址为 `*.pages.dev`。

构建命令与输出目录和 `package.json` 的 `build` 脚本一致；部署不需要任何环境变量。

## 技术栈（版本钉死）

| 依赖 | 版本 |
| --- | --- |
| React / React DOM | 19.3.1 |
| Vite | 7.3.8 |
| TypeScript | 5.9.3 |
| @vitejs/plugin-react | 4.7.0 |
| @ffmpeg/ffmpeg / @ffmpeg/core | 0.11.6 / 0.11.0（单线程 wasm，钉死） |
| vitest | 4.1.12 |

纯 CSS（CSS 变量），无 UI 组件库；录音库用 IndexedDB（库名 `suno-record-denoise`，`recordings` 存元数据、`audio` 存音频 Blob）。

## 结构

```
src/
  App.tsx                 # 三标签页：录制 / 降噪工作台 / 录音库（后两者 React.lazy）
  components/
    RecordView.tsx        # 标签页录制（三态检测）、麦克风、上传
    Workbench.tsx         # 波形、强度、静音门开关、指标、A/B 播放器、导出
    Library.tsx           # 录音库（标签页门控查询、试听 lazy audio）
    Waveform.tsx          # canvas 波形显示（v2 不再框选噪声段）
  audio/
    capture.ts            # getDisplayMedia / MediaRecorder（192 kbps）/ 三态检测
    dsp.ts                # 测量（频段/噪声底/削波/静音）、静音门、指标；不再含引擎
    ffmpegEngine.ts       # FFmpeg afftdn 引擎：wasm 懒加载、强度→nr/nf 映射
    fft.ts                # 基 2 迭代 FFT/IFFT
    loudness.ts           # 简化 BS.1770 + A/B 同响度增益
    wav.ts                # 16-bit PCM WAV 编解码
    validate.ts           # 上传格式 / 大小 / 时长校验
    db.ts                 # IndexedDB
    report.ts             # denoise-report.json
tests/
  dsp.test.ts             # DSP 数值测试（见 PROGRESS.md 的实测数）
```

## 已知限制

- 标签页录制只在桌面 Chrome / Edge 可用；Firefox / Safari 没有标签页音频；移动浏览器不支持。
- 每次录制都要重新点分享、重新勾选音频开关（浏览器安全规则，无法记住）。
- afftdn 对稳态杂音（底噪、风扇声、电流声）有效；突发噪声、混响、失真修不了。
- 降噪强度拉满会在安静段落留下轻微“水声”（音乐噪声），属谱门固有 artifact；默认 50% 是折中。
- 静音门默认关；打开后连续 ≥200 ms 的数字静音（RMS < −60 dBFS）在段首留 100 ms 后压到 0，淡入淡出各 50 ms，有声段完全不动。
- wasm 输出尾部比输入短 1391 采样（31.5 ms），只在尾部；头部与中部逐采样对齐，A/B 切换不受影响。
- 响度用的是简化 BS.1770（K 计权 + 门控），绝对 LUFS 与专业表可能差零点几 LU；A/B 只依赖两段的相对差，够用。
- 录音存在浏览器 IndexedDB 里：清浏览器数据会丢；换设备、换浏览器看不到。

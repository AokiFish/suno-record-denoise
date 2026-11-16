# PROGRESS — suno-record-denoise 脚手架

日期：2026-11-16。状态：**脚手架完成，本地验收全过；未推 GitHub、未动 Cloudflare（任务禁做，留父代理安排）。**

本地目录 `~/workspace/suno-record-denoise/`。远端空库 `AokiFish/suno-record-denoise` 已由 Luca 建好（MEMORY 记：初始提交 `ff5a6a6d` 可读），本子任务未推任何文件。

## 验收（逐条证据）

### 1. `npm run build` 退出 0

- `npm install`：plain 安装失败，npm arborist 报错 `Cannot read properties of null (reading 'edgesOut')`（Audio Lab 曾遇同款）；改 `npm install --legacy-peer-deps` 成功，`added 94 packages`。
- 实装版本核对：react 19.3.1、vite 7.3.8、TypeScript 5.9.3（与规格钉死版本一致）。
- `npx tsc --noEmit`：0 错误（中途修过 4 处：`loading` 属性用 spread-cast、`buildReport` 字段名 `loudnessDiffLu`、`@types/node` 补装、tsconfig `types` 加 `node`）。
- `npm run build`：退出 0，`vite v7.3.8 building… ✓ built in 1.97s`，43 个模块。

### 2. `npm run preview` 首页 200

- `npm run preview -- --port 4173` 后 curl：首页 `200 556 bytes`；`assets/index--VYoGgNW.js` 200；`assets/Workbench-DkMV0Kut.js` 200；`assets/Library-D8XglMCS.js` 200。
- `dist/index.html` 只引用主 JS + CSS，无外部资源（`grep -c "http"` = 0），`lang="zh-CN"`。
- **零控制台错误：未验。** 沙盒无 Chromium（`which chromium/google-chrome` 无结果），无头浏览器检查做不了；需 Luca 在真机打开页面后看控制台。

### 3. DSP 数值测试（`npm test`，17/17 通过）

fixture：3 秒粉红噪声（FFT 1/f，seed 42）+ 1 kHz 正弦 0.25，前 1 秒纯噪声；噪声谱从 0–1 秒学。另有静音 fixture（1 秒声 → 1 秒静音 → 1 秒声）。

| 断言 | 规格 | 实测 |
| --- | --- | --- |
| 强度 50% 噪声频段（5–10 kHz）下降 | ≥ 6 dB | **7.33 dB** |
| 1 kHz 所在 mid 段变化 | < 1 dB | **0.172 dB** |
| 强度 0、250 Hz 以上频段差 | < 0.3 dB | **0.121 dB**（最大值） |
| 零噪声谱 STFT 往返频谱差 | < 0.5 dB | 通过（<0.5） |
| 无新增削波 | ≤ 原削波数 | **0 → 0** |
| 静音段处理后（开头 100 ms 不计） | < −50 dBFS | **ok=true，max −120.0 dBFS** |
| 噪声底 | 下降 > 3 dB | **−32.4 → −43.0 dB**（降 10.6 dB） |
| 信噪比变化 | > 0 dB | **+10.28 dB** |
| FFT 正弦往返误差 | < 1e-5 | 通过 |
| 自动噪声段 | 落在最安静处 | 通过（静音在 1–2 秒，窗口与之重叠） |
| 真峰值 | — | −9.12 → −11.10 dBTP |
| 频谱距离（参考值） | 报告警告阈值 > 3 dB | 10.99 dB（fixture 噪声重，报告会出警告，属实） |

### 4. A/B 响度差 < 0.2 LU

440 Hz 正弦 2 秒，0.5 vs 0.25（−6 dB）：响度 −25.28 vs −31.31 LUFS（差 6.02 LU）→ `abGains` 给 −6.02 / 0.00 dB（两段都 ≤ 0、恰一个为 0）→ **匹配后差 0.0000 LU**。`src/components/Workbench.tsx:139-144` 正确映射 `gainAdb/gainBdb`。

### 5. 上传校验

vitest `上传校验` 组 7/7 通过：wav / mp3 / flac / m4a 通过；`notes.txt` 拒收 `UNSUPPORTED_FORMAT`；> 80 MB 拒收 `FILE_TOO_LARGE`；> 600 秒拒收 `DURATION_TOO_LONG`。注：这是校验函数的单元测试，浏览器里真实四格式解码上传未验（无浏览器）。

### 6. 导出 WAV ffprobe

`tests/out/denoised.wav`（测试写盘）：`pcm_s16le`、`sample_rate=44100`、`channels=2`、`bits_per_sample=16`、`duration=3.000000`（3 秒 fixture，时长误差 0 ms ≤ 10 ms）。

### 7. README 命令与 package.json 一致

`package.json` scripts：`build` = `tsc && vite build`、`check` = `tsc --noEmit && npm test && npm run build`、`dev` = `vite`、`preview` = `vite preview`、`test` = `vitest run`。README 逐字照抄；部署段写明构建命令 `npm run build`、输出目录 `dist`、零环境变量、零 R2/KV/D1。

### 8. 懒加载实测数

- JS 分块（`npm run build` 输出）：`index--VYoGgNW.js` **238.36 kB**（gzip 76.14 kB，首屏唯一 JS）+ `Workbench-DkMV0Kut.js` **20.25 kB**（gzip 7.85 kB，React.lazy，点开降噪工作台才加载）+ `Library-D8XglMCS.js` **1.91 kB**（gzip 0.91 kB，React.lazy，点开录音库才加载）；CSS 4.11 kB；`dist` 总计 265,178 字节。
- 首屏音频字节：**0**。首屏是录制页，没有 `<audio>`；试听 `<audio>` 只在录音库行内，点开试听才建 blob URL，且带 `loading="lazy"` + `preload="metadata"` + `controls`。
- 列表查询门控：Library 挂载（点开标签页）时才读 IndexedDB `count()` + 元数据；失败有重试按钮。
- 无外部字体：全仓 `grep fonts.googleapis|fonts.gstatic|@import` 零命中，系统字体栈。
- **移动端 settle 时间：未验。** 沙盒无浏览器、无线上地址，测不了；待部署后真机测。

## 验收中修掉的三个真问题（附前后数字）

1. **噪声谱中位数低估**：周期图功率服从指数分布，中位数 = 均值 × ln2；原 `learnNoiseProfile` 直接取中位数，谱减法减得不够，brilliance 只降 3.20 dB。修：中位数 × 1/ln2（≈1.4427）得均值无偏估计 → **7.33 dB**。
2. **增益逐频点跳变 → 音乐噪声 + STFT 预回声**：原每频点独立增益，等效滤波器时域拖尾长，静音段尾部 100 ms 块测到 −37 dBFS。修：增益 ±2 bins 平滑 → 尾部块降到 −45.5 dBFS（仍不够，见 3）。
3. **静音门**：新增 `silenceGateEnvelope`（`src/audio/dsp.ts`）：输入 RMS < −60 dBFS、连续 ≥200 ms 的静音段，段首留 100 ms 后压到 0，段尾 10 ms 淡入恢复（代价：静音后恢复的声音前 10 ms 淡入）。静音段内部本来就该是静音，门只按输入静音图动作，不碰有声段 → 静音 max **−120.0 dBFS**。三处均已写进代码注释与 README 已知限制。

## Modern Web Guidance 披露（Step 4，只认本轮实际落地的）

- `lazy-load-video-and-audio`：Library 试听 `<audio>` 用 `{...({ loading: 'lazy' } as const)}` spread-cast（React 类型无此属性）+ `controls` + `preload="metadata"`。规则原文：*"Always include `controls` on `<audio loading=\"lazy\">`. Because `<audio>` elements have no intrinsic visual box without browser controls, an `<audio loading=\"lazy\">` element without `controls` cannot visibly intersect the viewport and will never load or autoplay."* 另：*"Pair `loading=\"lazy\"` with `preload=\"none\"` when the user must explicitly press play after scrolling to the media, or `preload=\"metadata\"` when duration and initial frame data should populate automatically once the player enters the viewport."*（本项目取后者）及 *"Browsers that do not recognize `loading=\"lazy\"` on `<video>` and `<audio>` ignore the attribute and fall back to standard loading governed by the `preload` attribute."*（Firefox/Safari 靠 `preload="metadata"` 兜底，不下载整段音频）。
- `accessibility`：强度滑块、播放位置滑块用 `<label htmlFor>` 显式关联控件。规则原文：*"Explicitly associate `<label>` with its control via `for`/`id`: As well as ensuring the control is appropriately labeled by the contents of the `<label>` element, this results in a larger target area for people to activate the label _or_ its related control to move focus to the control…"* 另有 `aria-live="polite"` 状态区、`role="alert"` 错误提示、`aria-label` 导航/分组。

## 未验项（留给 Luca / 父代理）

1. **真机标签页录制**：沙盒无浏览器、拿不到媒体权限；须 Luca 在部署后的顶层页实测：选 Suno 标签页 + 勾选共享音频，录一段看波形与入库。
2. **真机麦克风录音**：同上，权限原因未验。
3. **浏览器里四格式真实上传解码**：只验了校验函数，未验 `decodeAudioData` 真实解码。
4. **控制台零错误**：无浏览器，未验。
5. **移动端 settle / 真机懒加载体感**：未验。
6. **IndexedDB 真实读写**：只验了逻辑层（db.ts 未进 vitest 环境），未在浏览器里跑通存取。

## 禁做清单核对

- 未推 GitHub、未动 Cloudflare。✓
- 无多轨/人声分离/修削波；文案无“AI 降噪模型”自称。✓
- 无假处理、无编数字编链接（README 的 Audio Lab 链接是 Luca 仓库的真实地址；Cloudflare 步骤按官方文档的流程写，未编 URL）。✓
- 无外部字体 @import；首屏不全加载（见 §8）。✓
- 旧“手机浏览器不支持”误报文案未出现；三态文案为可用/被拦/不支持。✓
- iframe 里被拦的录制逻辑没有原样搬过来冒充修好——`capture.ts` 的 `detectCaptureState` 在 iframe 内无接口时判 `blocked`，按钮禁用 + 如实说明。✓

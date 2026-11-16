# PROGRESS — suno-record-denoise 脚手架

日期：2026-11-16。状态：**v3 完成，本地验收全过（`npm run check` 退出 0，28/28 测试）；未推 GitHub、未动 Cloudflare（任务禁做，留父代理安排）。**

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

## v2 引擎重做（2026-11-16，Luca 实测批评后）

- 2026-11-16 14:35 触发提交：验证 Cloudflare 重连 GitHub 后 push 是否自动部署（3fc2cc54 推时连接已断，未触发构建）。

### 验收（v2，逐条证据）

- `npm run check` 退出 0（`tsc --noEmit && npm test && npm run build`）：tsc 0 错误；vitest **24/24 通过**（`tests/dsp.test.ts` 18、真歌 CLI 5、真歌 wasm 1）；`vite build` 退出 0，`✓ built in 2.35s`。注：中途一次全量跑曾有 1 个门测试失败（单跑通过；失败位置在 `it` 行、无断言错误，疑似并行跑时超 5 s 默认超时——该测试曾逐采样做 26 万次 `expect`）——已改成先算最大差、一次断言，重跑全绿。
- CLI ffmpeg 8.1 与 wasm 双线真歌指标表齐全（见下表），默认强度 0.5 全部验收项通过。
- README / PROJECT-SPEC.md / PROGRESS.md 三份文档已更新（本节 + README“引擎选型”+ PROJECT-SPEC §7）。

### 真歌 fixture（来源与许可）

贝多芬《月光奏鸣曲》第一乐章，钢琴演奏 eldüendesüarez，Wikimedia Commons **CC BY-SA 4.0**，文件页 https://commons.wikimedia.org/wiki/File:Beethoven_-_Moonlight_Sonata_Op-27_No-2_(Piano_Performance_by_eld%C3%BCendes%C3%BCarez).wav。`tests/eval/build-fixture.py` 生成 `tests/fixtures/fixture42.wav`（42.000000 秒）：[0–1 s 纯粉红噪声][1–21 s 歌 + 粉红噪声][21–22 s 精确数字静音][22–42 s 歌 + 噪声]；`clean42.wav` 同布局、只有歌（1 秒静音头）。歌取原曲 10–50 秒、衰减 1 dB 留头空间；粉红噪声 FFT 1/f，左右声道独立种子。**SNR 恰好 20.00 dB**（歌 RMS −21.82 dBFS，噪声 RMS −41.82 dBFS）；混合峰值 −1.02 dBFS（无削波）；头 1 秒 RMS −41.96 dBFS；21–22 秒经核实为精确数字静音。各频段信噪比（干净音乐 vs 加入噪声）：sub 20–60 Hz −28.3、bass 60–250 +2.22、低中 250–500 +8.35、中频 500–2000 +8.85、presence 2–5k −6.46、brilliance 5–10k −27.61、air 10–20k −49.67 dB。噪声主导频段：brilliance、air、sub、presence。

频段定义：sub 20–60、bass 60–250、低中 250–500、中频 500–2000、presence 2–5k、brilliance 5–10k、air 10–20k；频段电平是相对总功率的份额，绝对带电平（dBFS）= 相对带电平 + 总 RMS dB；低频段 20–250 Hz 合并绝对电平 = 10·log10(10^(sub/10)+10^(bass/10))。

### 出货链与强度映射表（wasm 核心上标定）

出货链：`highpass=f=90,afftdn=nr=X:nf=Y`，**不采样**（默认白噪声谱形）。`nf` 全程锁 −30，`nr` 负责深度（低频/中频变化只由 `nf` 决定、与 `nr` 无关，CLI 与 wasm 两线一致）。

| 强度 | nr / nf | brilliance 5–10k（wasm） | air 10–20k（wasm） | 低频 20–250（wasm） | 中频 500–2000（wasm） |
| --- | --- | --- | --- | --- | --- |
| 0.25 | 6 / −30 | −4.56 dB | −5.83 dB | −0.59 dB | 0.00 dB |
| 0.50（默认） | 12 / −30 | **−7.15 dB** | **−11.11 dB** | −0.56 dB | −0.01 dB |
| 0.75 | 20 / −30 | −8.58 dB | −15.56 dB | −0.59 dB | −0.00 dB |
| 1.00 | 30 / −30 | −9.18 dB | −17.50 dB | −0.59 dB | −0.00 dB |

强度 0 = 只做 90 Hz 高通，不进 afftdn；0–0.25 段 `nf` 从 −80 线性插到 −30。0.50 行是最终测试跑的实测数（`tests/out/real-song-wasm-metrics.json`），其余三行来自梯子扫参。

### 真歌指标表（默认强度 0.5，出货链）

| 验收项 | 标准 | CLI ffmpeg 8.1（交叉对照） | wasm core 0.11.0（出货核心） |
| --- | --- | --- | --- |
| 噪声频段 brilliance 5–10k 降 | ≥ 6 dB | **−11.27 dB** ✓ | **−7.15 dB** ✓ |
| 噪声频段 air 10–20k 降 | ≥ 6 dB | **−11.91 dB** ✓ | **−11.11 dB** ✓ |
| 低频段 20–250 Hz 变化（合并绝对电平） | < 1 dB | **−0.68 dB** ✓ | **−0.56 dB** ✓ |
| 中频段 500–2000 Hz 变化 | < 1 dB | **−0.09 dB** ✓ | **−0.01 dB** ✓ |
| 新增削波 | 0 | 0 → 0 ✓ | 0 → 0 ✓ |
| 静音段（21–22 s，头 100 ms 不计） | < −50 dBFS | −120.00 dBFS ✓ | −69.97 dBFS ✓ |
| 噪声底 | — | −36.76 → −39.76 dBFS | −37.18 → −39.78 dBFS |
| 信噪比变化 | — | +2.81 dB | +2.47 dB |
| 处理耗时（42 秒立体声） | — | — | 5.4 秒（一次完整调用，含首次加载核心） |

完整绝对带电平变化（dB，sub/bass/低中/中频/presence/brilliance/air）：CLI [−18.27, −0.59, +0.04, −0.09, −1.67, −11.27, −11.91]；wasm [−16.61, −0.47, −0.02, −0.01, −0.57, −7.15, −11.11]。指标文件：`tests/out/real-song-metrics.json`（CLI）、`tests/out/real-song-wasm-metrics.json`（wasm）。

**低频段口径说明（不凑数）**：90 Hz 高通单独就让 sub 20–60 Hz 相对电平动 −15.66 dB（绝对 −15.76 dB），sub 单独算永远过不了 <1 dB 的线；验收按 20–250 Hz 合并绝对电平算（sub 只占该段功率约 2%），两线分别为 −0.68 / −0.56 dB。口径已写入 PROJECT-SPEC §7，报给父代理。

### wasm vs CLI 标定差异（关键发现）

同一份 afftdn 源码（5.1 与 8.1 的 `process_frame` 增益数学、`finish_sample_noise`、`config_input` 逐行 diff 过，逻辑相同；8.1 只多了 `adaptivity`/`floor_offset`/`noise_link`/`band_multiplier`/`gain_smooth` 五个选项），在 wasm core 0.11.0（FFmpeg 5.1 系）与本机 ffmpeg 8.1 上的 `nf` 标定差约 **20 dB**（wasm `nf=−30` ≈ CLI `nf=−50` 的效果）。证据：

- 采样谱形：CLI 8.1 自身日志 `bn=` 峰 +14 dB@270 Hz；wasm 核心日志的采样谱是 −1/0/0/−2/−4/−8/−12/−17/−22/−24…（高频段被压到 −24 限幅），形状完全不同。
- 8.1 新选项已逐一排除：CLI 上 `ad=0`、`bm=1`、`ad=0:bm=1` 均不改变结果（brill −8.05/−8.32/−8.06 vs 基准 −8.31）。
- 结论：差异在构建层，不在参数层。**出货链必须在 wasm 核心上标定，CLI 数字不能直接当出货数**；“本机真 ffmpeg（同款 libavfilter 代码）先验证”的前提在实践中不成立，验收以 wasm 线为准。

### 否掉的方案（实测数）

- **`sn` 采样**：CLI 采样链 nf=−35 时 brill −8.31、air −10.94、低频 −0.86（能过）；但 wasm 采样链最好成绩是 nf=−20/nr=30 的 **brill −5.10、air −9.15**（`nf` 已到上限 −20，无路可抬），达不到 ≥6 dB 线；且采样在 CLI 上把低频推过线（nf=−30 时低频 −1.30 dB）。机制已从源码证实：`finish_sample_noise` 把采样谱减均值后只留形状，粉红噪声谱形把高频段的噪声方差估计压低约 16 倍（exp(−12·C)=0.063，C=0.2303），Wiener 增益把高频噪声当信号放过；默认 nf=−50 采样链 brill 只有 −0.64 dB。**出货链不用采样**，工作台的噪声段框选 UI 已去掉，不留摆设控件。
- **LR4 分频（250 Hz 以下直通）**：分频重构本身让低频段动 **−2.40 dB**（交叉区相位求和失配），比不分频的 −0.62 dB 更差；且分频版噪声频段只降 −1.82/−1.89 dB（采样链）。已删除。
- **`bn` 自定义低频保护**：源码 `set_noise_profile` 直接 memcpy 覆盖 `band_noise`，采样与 `bn` 不能共存；不采样链上 `bn='-24|-24|-24|0|…'` 与默认谱形结果完全相同（低频 −0.62、中频 −0.01、brill −6.25、air −10.87），冗余。不用。
- **noisereduce 移植**：原任务，后被 afftdn 取代（指挥官追加结论）。阅读不白费，见下节对照。

### noisereduce vs afftdn 对照（都读过源码原文）

noisereduce（`/tmp/noisereduce-src`，HEAD `51c85343`，已核对 `noisereduce.py` + `spectralgate/stationary.py` + `base.py` + `utils.py`；注意：源码默认 `n_fft=1024`，不是原任务简报写的 2048）：

| 维度 | noisereduce 平稳谱门 | FFmpeg afftdn（出货引擎） |
| --- | --- | --- |
| 阈值 | 每频点 dB 均值 + 1.5σ（`n_std_thresh_stationary=1.5`） | 每频带方差比的 Wiener 增益（`power/abs_var`，先验平滑） |
| 谱分辨率 | 全分辨率逐频点（n_fft 1024 → 513 bins） | 15 段频带（中心 80/120/180/270/410/620/930/1400/2100/3150/4750/7100/10700/16000/24000 Hz） |
| 掩码 | 二值掩码 → 软掩码 `mask*prop_decrease + (1−prop_decrease)`（默认 prop_decrease=1.0） | 连续 Wiener 增益 + 频带上限钳制（`max_gain = exp(nr·0.5·C)`） |
| 平滑 | 显式二维三角平滑：频域 500 Hz、时域 50 ms（`freq_mask_smooth_hz=500`、`time_mask_smooth_ms=50`） | 先验平滑（`ratio`；5.1 未赋值=0）+ 可选 `gain_smooth`（8.1 才有，出货链不用） |
| 噪声采样语义 | 噪声段的绝对 dB 电平直接作阈值 | 采样谱**减均值后只留形状**，绝对电平来自 `nf`（这就是粉红采样失效的根因） |
| STFT | scipy，Hann 窗，hop = win/4，整文件离线 | 流式滤镜，`window_length = 3×(sr/80)`（44.1k 时约 37.5 ms），fft 2048，sin² 窗 |
| 时间常数 | `time_constant_s=2.0`（非平稳平滑） | 无等价参数；`tn` 跟踪噪声 |

### 录制修复与静音门（v2）

- `MediaRecorder` 加 `audioBitsPerSecond: 192000`（`src/audio/capture.ts`；v1 没设码率，是低声部卡顿的嫌疑点之一）。
- 前台警告：录制页标签页卡常驻警告（Suno 标签页与本站标签页都要保持前台，切后台会被 Chrome 节流、录音断点）；麦克风卡在录音进行中显示本站前台版警告。
- chunk 元数据：`ActiveRecording.stats()` 返回 `{ chunkCount, totalBytes }`（250 ms 一 chunk，60 秒应有约 240 个）；`RecordingMeta` 新增可选字段 `chunkCount` / `totalBytes`，存库供断点定位（数量明显偏少或总字节与时长对不上，说明录制中被节流丢过数据）。
- 静音门：默认关，工作台加开关；开时淡入淡出 50 ms（v1 的 10 ms 太短，不到 50 Hz 一个周期 20 ms）；只在全频段 RMS < −60 dBFS、连续 ≥200 ms 的段动作，段首留 100 ms。测试：有声段逐采样相同、1 秒静音段包络中点约 0.5、100 ms 短静音不动作（`tests/dsp.test.ts` 静音门组）。
- 250 Hz 以下保护：在 afftdn 链里实现——低频保护由 `nf=−30` 上限保证，不另做分频（见否掉的方案）。

### 工程备注（实现时踩到的）

- **Node 里跑 wasm 要 fetch shim**：0.11.0 的 Emscripten core 在 Node 里仍用 `fetch` 读 `.wasm`，但传的是裸文件系统路径 → Invalid URL。`tests/real-song-wasm.test.ts` 的 shim 拦截以 `/` 开头的字符串输入，经 fs 读后返回 `Content-Type: application/wasm` 的 Response；其余 fetch 原样放行。只解决 Node 文件加载，不改 afftdn/滤镜/wasm 代码；浏览器路径不受影响。
- **WAV 解码器修 LIST-INFO**：ffmpeg 的 wav muxer 在 fmt 与 data 之间写 LIST-INFO 块（ISFT Lavf58.45.100），`parseWavHeader` 曾假定 data 在偏移 36 处，wasm 输出解码失败。已改成走子块（`src/audio/wav.ts`，`WavHeader` 加 `dataOffset`）。
- **wasm 尾部短 1391 采样（31.5 ms）**：输出 1,850,809 vs 输入 1,852,200；缺的只在尾部——静音缺口起止采样三线完全一致、5–6 s 互相关滞后 3 采样，头/中逐采样对齐，A/B 切换不受影响。测试已允许长度在 (42·SR−4096, 42·SR] 并按输出长度截断 fixture 再算指标。
- **Node 脚本跑完 wasm 不退出**：Emscripten pthread worker 让事件循环活着，须调 `ffmpeg.exit()`；vitest 会杀 worker，不受影响。
- **v1 合成音测试**：`tests/dsp.test.ts` 已重写——删旧引擎测试（`learnNoiseProfile`/`processAudio`/`HIGHPASS_HZ`），保留测量辅助 + 找最安静窗口 + FFT 往返 + A/B + WAV 导出 + 上传校验；新增静音门组（3 个）与滤镜串组（锚点/插值/不含 `sn` 采样断言）。原验收“掩码平滑测试（相邻帧掩码变化有界）”不适用：afftdn 的掩码/平滑在 libavfilter 内部，没有 JS 掩码可测，改为上述滤镜串测试 + 真歌双线指标表。
- **`.gitignore`**：已加 `tests/fixtures/`（21 MB，fixture 与源 wav 不入库）。
- `public/ffmpeg/`：core 文件由 postinstall 从已装的 `@ffmpeg/core` 包自动生成（`scripts/fetch-ffmpeg-core.mjs`，拷 `ffmpeg-core.js` 106,139 B、`ffmpeg-core.wasm` 24,465,514 B、`ffmpeg-core.worker.js` 3,609 B，合计 24 MB，与包内文件 sha256 逐字节相同），不入库；`package.json` 已装 `@ffmpeg/ffmpeg@0.11.6` + `@ffmpeg/core@0.11.0`（`npm install --legacy-peer-deps`）。已实测：删掉 `public/ffmpeg/` 后重装 + 构建，文件自动再生、`dist/ffmpeg/` 齐全。

### 未验项（v2 新增，留给 Luca / 父代理）

1. **真机录制**：仍待 Luca——标签页录制（选 Suno 标签页 + 勾选共享音频）、麦克风录音、前台警告是否出现、chunk 数是否与时长对得上（60 秒约 240 个）。
2. **真浏览器里的 wasm 降噪**：只在 Node 里跑过 wasm 核心（fetch shim + `@ffmpeg/core` 直引）；浏览器里 `public/ffmpeg/` 的 core 加载、工作台懒加载、进度条、A/B 播放均未验（沙盒无浏览器）。须 Luca 在部署后的顶层页实测。
3. **真机标签页抓取与麦克风录音**：同 v1 未验项 1–2，未变。
4. **浏览器里四格式真实上传解码 / 控制台零错误 / 移动端 settle / IndexedDB 真实读写**：同 v1 未验项 3–6，未变。

## 禁做清单核对

- 未推 GitHub、未动 Cloudflare。✓
- 无多轨/人声分离/修削波；文案无“AI 降噪模型”自称。✓
- 无假处理、无编数字编链接（README 的 Audio Lab 链接是 Luca 仓库的真实地址；Cloudflare 步骤按官方文档的流程写，未编 URL）。✓
- 无外部字体 @import；首屏不全加载（见 §8）。✓
- 旧“手机浏览器不支持”误报文案未出现；三态文案为可用/被拦/不支持。✓
- iframe 里被拦的录制逻辑没有原样搬过来冒充修好——`capture.ts` 的 `detectCaptureState` 在 iframe 内无接口时判 `blocked`，按钮禁用 + 如实说明。✓

## v3 修复（2026-11-16，Luca 真机报 bug 后）

**正名**：v2 节里两处说法作废，以本节为准——① “core 0.11.0 是单线程版”（它是多线程版）；② “`public/ffmpeg/` 由 `@ffmpeg/core` 包自动生成”（v3 起由 `@ffmpeg/core-st` 生成）。其余 v2 实测数（CLI 线、采样/LR4/`bn` 否决、nf 标定差）不受影响。

### 两个根因 + 证据

**根因 1——引擎（v2 用错 core）**：v2 用的 `@ffmpeg/core@0.11.0` 是多线程版，不是单线程版。证据：它的 JS 里 `SharedArrayBuffer` 出现 4 次，core-st 是 0 次；core-st 的 JS 里 `_main` 3 处、`_proxy_main` 0 处（多线程版反之）。SharedArrayBuffer 只在 COOP/COEP 跨域隔离下才存在，Cloudflare Pages 默认不发这两个头，无隔离的页面里根本没有这个对象。Luca 2026-11-16 14:49 真机亲眼看到原文：`SharedArrayBuffer is not defined`，降噪恒失败。Node 自带 SharedArrayBuffer，所以 v2 的全部 Node 测试都过了、真机才炸——v2 的漏验，本节的 SAB 测试就是补这个漏验。

**根因 2——播放门（Workbench）**：`src/components/Workbench.tsx` 的 `startBoth()` 在 `origBufRef.current` 与 `procBufRef.current` 有一个不存在时就直接 return；`procBufRef` 只在降噪成功后才有；引擎一失败 → `processed` 恒为 null → `startBoth` 直接返回 → 原声也播不了。v1 的手写 DSP 是同步的、总能成功，所以这个门一直潜伏着；v2 引擎一失败就变成永久性的。`src/components/Library.tsx` 不许动（无证据表明它坏了），未动。

### 改动

**引擎换官方单线程版 `@ffmpeg/core-st@0.11.1`**（`package.json` dependencies，钉死 0.11.1，不许用 `^` 浮动；`@ffmpeg/core@0.11.0` 只留 devDependencies，供 SAB 回归测试当反例，永不打包进应用）：
- `scripts/fetch-ffmpeg-core.mjs` 改成从 `@ffmpeg/core-st/dist` 拷：`ffmpeg-core.js` 86,313 B、`ffmpeg-core.wasm` 24,383,038 B、`ffmpeg-core.worker.js` 0 B（占位文件，单线程版不起 pthread worker；但浏览器 loader 会按 corePath 同名推导它的路径，缺一不可）。三文件与包内文件 sha256 逐字节相同。已实测：`rm -rf public/ffmpeg && npm install --legacy-peer-deps` 后三文件自动再生、`npm run build` 后 `dist/ffmpeg/` 齐全。
- `mainName: 'main'`：core-st 只导出 `_main`，不导出多线程版的 `_proxy_main`；不传会报 `Cannot call unknown function proxy_main`（已实测，见下“探针”）。
- **单次运行 + 跑完丢弃实例**：core-st 实例 main 返回后 Emscripten runtime 退出，同一实例第二次 run 报 `Program terminated with exit(0)`。`processWithFfmpeg` 每次跑完即在 finally 里丢弃实例（`ffmpegInstance = null; loadPromise = null`），下次调用重新加载（文件已缓存，只重建实例）。工作台 400 ms 防抖重算就靠这个。

**播放与降噪解耦（`src/components/Workbench.tsx` + 新增 `src/audio/playback.ts`）**：
- `startBoth` 不许再因为缺一边就整体 return——有哪边播哪边；请求的一侧不存在时退到另一侧，两侧都不存在才返回。
- `togglePlay` 默认走原声（v2 是默认走降噪后）；`switchSide('proc')` 在 processed 为 null 时直接返回，不许杀掉正在播的原声；已在播放时只调已存在的增益节点。
- 降噪后按钮在 processed 为 null 时 `disabled` + `title` 说明；引擎失败时下方有看得见的红字状态（原声仍可正常播放），加载中/未就绪时有 muted 提示。两边都有时同响度 A/B 行为不变。400 ms 防抖自动重算与引擎失败如实报错保留。
- `playableSides(hasProcessed)` 纯函数（`src/audio/playback.ts`）：原声永远可播，降噪后只有 processed 存在时可播；工作台与测试共用同一条规则。

### 验收（v3，逐条证据）

- `npm run check` 退出 0：`tsc --noEmit` 0 错误；vitest **28/28 通过**（`tests/dsp.test.ts` 18、真歌 CLI 5、真歌 wasm 2、SAB 1、播放门 2）；`vite build` 退出 0（63 模块，`✓ built in 2.18s`；新 chunk：`index-BRgKEyjr.js` 239.27 kB、`Workbench-A83ehxh3.js` 35.30 kB）。
- SAB 删除测试（`tests/sab.test.ts`，1/1 通过）：Node 里 `globalThis.SharedArrayBuffer = undefined` 后，旧 MT core `loadFfmpeg('@ffmpeg/core')` 加载失败（只断言失败，不对报错文案做断言——Node 里的文案是 `Right-hand side of 'instanceof' is not an object`，与浏览器里的 `SharedArrayBuffer is not defined` 不同，根因同一）；core-st 加载成功，并在真歌 fixture 上跑通出货链，指标与下表 0.50 行逐值相同（用时 1.3 秒）。
- core-st 真歌指标表（默认强度 0.5，出货链 `highpass=f=90,afftdn=nr=12:nf=-30`）：与 v2 的 MT core 数**逐值相同**（`tests/out/real-song-wasm-metrics.json` 已重写，engine 字段为 `ffmpeg.wasm 0.11.6 + @ffmpeg/core-st 0.11.1`；输出采样数 1,850,809，与 v2 相同，尾部短 1391 采样不变）。

| 验收项 | 标准 | CLI ffmpeg 8.1（交叉对照，未变） | core-st 0.11.1（出货核心） |
| --- | --- | --- | --- |
| brilliance 5–10k 降 | ≥ 6 dB | **−11.27 dB** ✓ | **−7.15 dB** ✓ |
| air 10–20k 降 | ≥ 6 dB | **−11.91 dB** ✓ | **−11.11 dB** ✓ |
| 低频段 20–250 Hz 变化 | < 1 dB | **−0.68 dB** ✓ | **−0.56 dB** ✓ |
| 中频段 500–2000 Hz 变化 | < 1 dB | **−0.09 dB** ✓ | **−0.01 dB** ✓ |
| 新增削波 | 0 | 0 → 0 ✓ | 0 → 0 ✓ |
| 静音段 | < −50 dBFS | −120.00 dBFS ✓ | −69.97 dBFS ✓ |
| 噪声底 / SNR 变化 | — | −36.76 → −39.76 / +2.81 | −37.18 → −39.78 / +2.47 |

- 强度映射表四锚点在 core-st 上重测（临时测试 `tests/ladder-st.tmp.test.ts`，跑完已删；nr/nf 锚点不变）：

| 强度 | nr / nf | brilliance（core-st） | air（core-st） | 低频（core-st） | 中频（core-st） |
| --- | --- | --- | --- | --- | --- |
| 0.25 | 6 / −30 | −4.58 dB | −5.85 dB | −0.56 dB | −0.01 dB |
| 0.50（默认） | 12 / −30 | −7.15 dB | −11.11 dB | −0.56 dB | −0.01 dB |
| 0.75 | 20 / −30 | −8.60 dB | −15.59 dB | −0.56 dB | −0.01 dB |
| 1.00 | 30 / −30 | −9.20 dB | −17.52 dB | −0.56 dB | −0.01 dB |

与 v2 在 MT core 上的梯子数逐值相差 ≤0.03 dB（舍入级），映射表不变，不重标。
- 连续跑两次测试（`tests/real-song-wasm.test.ts` 新增，1/1 通过）：同一 `processWithFfmpeg` 接口连续跑两次都成功（第二次自动重载实例），两次输出均为 42,978 采样。
- 播放门测试（`tests/playback.test.ts`，2/2 通过）：`playableSides(false)` → `{ orig: true, proc: false }`；`playableSides(true)` → `{ orig: true, proc: true }`。
- README / PROJECT-SPEC.md / PROGRESS.md 三份文档已更新（本节 + README“引擎选型 v3”+ PROJECT-SPEC §4/§7/§8）；v2 的“core 0.11.0 单线程”错误说法在 README、PROJECT-SPEC、引擎注释、fetch 脚本四处已纠正。

### 探针记录（单次运行问题是怎么查到的）

梯子临时测试第一次跑时只出了 0.25 行就失败：`ExitStatus: Program terminated with exit(0)`。两个探针（临时测试 `tests/probe-rerun.tmp.test.ts`，跑完已删）：
- 探针 A（全局 `Module.noExitRuntime = true`，同一实例跑两次）：第 1 次输出 42,978 采样，第 2 次照样 `Program terminated with exit(0)`——全局设置救不了，工厂不采纳。
- 探针 B（全新实例重载再跑）：第 1 个实例跑完 42,978 采样，第 2 个全新实例加载后跑出 42,978 采样——重载可跑。
- 另：`@ffmpeg/ffmpeg@0.11.6` 的 `createFFmpeg` 调 `createFFmpegCore` 时只传 `mainScriptUrlOrBlob` / `print` / `printErr` / `locateFile` 四个字段（已读源码），不透传 `noExitRuntime`——所以只能用“跑完丢弃实例”这一招。结论已写进 `src/audio/ffmpegEngine.ts` 的 `loadFfmpeg` 注释与本节。

### 否掉的方案

- **多线程 core + Pages `_headers` 发 COOP/COEP**：能行（Pages 支持 `_headers`），但 COEP 会要求所有子资源带 CORP，牵连面大；core-st 同数零配置，更简单。不用。
- **0.12.x**：任务钉死 0.11 线，无收益。不升。
- **全局 `Module.noExitRuntime`**：探针 A 实测无效。不用。
- **绕过 `@ffmpeg/ffmpeg` 直接调 core 工厂**：改动大（load/run/FS/进度都要重写），没必要——重载实例已够用。不用。
- **悄悄切回旧手写引擎**：已删，永不回来。不用。

### 已知限制（v3 新增）

- 单线程 core 跑在调用线程上：长歌降噪期间主线程会被占住，进度条可能跳变而非平滑推进；跑完即恢复。已写入 README 已知限制。
- 每次降噪都会重新加载引擎实例（core-st 单次运行所致）；文件已缓存，只重建实例，42 秒歌单次约 1–4 秒。

### 未验项（v3，sandbox-only，留给 Luca 真机）

1. **真浏览器里的 core-st 加载与降噪**：只在 Node 里跑过（fetch shim + `@ffmpeg/core-st` 直引）；浏览器里 `public/ffmpeg/` 的 core-st 加载、工作台懒加载、进度条、连续重算均未验（沙盒无浏览器）。须 Luca 在部署后的顶层页实测——重点是：打开工作台不再报 SharedArrayBuffer、拖强度滑块重算不报错。
2. **真机播放**：原声可播、降噪后可用、A/B 切换不杀声，均未验。须 Luca 真机实测。
3. v2 未验项 1、3、4 未变（真机录制、四格式真实上传解码、控制台零错误、移动端 settle、IndexedDB 真实读写）。

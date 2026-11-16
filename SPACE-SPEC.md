# Suno 录音降噪空间 — 建造规格（待 Luca 选口径后开工）

> 状态：2026-11-16 11:59 Luca 已定口径：他在网页上播放歌曲，空间直接录制。已开工建造。
> 本文件是 delegation-contract brief 草稿：目标、已核验事实原文、来源、禁做清单、可核验验收标准。

## 1. 目标（具体）

建一个全栈空间（需存录音库，故全栈，不建静态版），流程：录音/导入 → 学噪声 → 降噪 → 同响度 A/B 对比 → 导出干净 WAV → 送 Audio Lab 做增效。
核心指标是“逼近原声”：降噪只去稳态杂音，不动原声频谱与动态；每一步给数字，不靠耳朵吹。

## 2. 已核验事实原文

- Audio Lab（`~/workspace/audio-lab`，M0/M1/M2 已完成，2026-11-16）：Suno 歌曲音质提升网站，上传 → 选声音目标 → 同响度 A/B 试听 → 导出。docs/01-product.md MVP 明确不做：“降噪、修复削波、音色转换等 AI 模型”。4 个目标 balanced/warm/bright/punch，强度 0–100% 默认 70%，导出 WAV(24-bit)/FLAC/MP3(320kbps)，响度默认 -14 LUFS。上传校验 80 MB、10 分钟、wav/mp3/flac/m4a。
- 浏览器录音（实测来源：web 搜索 2026-11-16）：`navigator.mediaDevices.getUserMedia({audio: {noiseSuppression, echoCancellation}})` + MediaRecorder，首选 `audio/webm;codecs=opus`，48 kHz；浏览器不能直接录 MP3，导出需解码后转 WAV。
- 降噪做法（实测来源：web 搜索 2026-11-16）：两层。(1) 录制时浏览器自带 `noiseSuppression: true`（可开关，专业录音要能关掉）；(2) 事后 FFT 谱减法/谱门：取 1–2 秒纯噪声段学生噪声谱，从全曲减去；高通切 80 Hz 以下隆隆声。只对稳态杂音（风扇、电流 hum、嘶声、房间底噪）有效；突发人声、车流、间歇咔哒声去不干净；强度过高产生音乐噪声伪影、损伤原声。
- Suno 导入（suno-downloader skill，`~/workspace/custom-skills/suno-downloader/SKILL.md`）：只下自己的歌；只走已登录 suno.com 会话，token 取自页面 Clerk 会话，不问密码；Chrome/Edge 才有完整能力；先小批量试跑。空间本身拿不到 Suno 登录态，不能直连拉曲库。
- 模板与 UI 参照：Audio Lab docs/06 UI 规范（克制：一个页面一个主要动作，同时可见可操作元素尽量 ≤7 个；A/B 切换播放位置不变；文案集中管理，不用术语）；顶级模板库 `~/workspace/research_notes/top-templates-2026-11-15/templates.md`（建空间先抄版式，不从零设计）。

## 3. 来源

- `~/workspace/audio-lab/docs/01-product.md`、`docs/02-audio-quality.md`、`docs/06-ui-spec.md`、`PROGRESS.md`
- `~/workspace/custom-skills/suno-downloader/SKILL.md`
- web 搜索 2026-11-16：MediaRecorder/RNNoise、Web Audio 谱减法（结果见对话）
- modern-web-guidance：`lazy-load-video-and-audio`、`accessibility`（已 retrieve，未落代码）

## 4. 口径（Luca 2026-11-16 11:59 已定）

主入口 = 网页播放录制：Luca 在网页（Suno）上播放自己的歌，空间直接录制。技术实现：空间在 Luca 的浏览器里调 `getDisplayMedia`，请他分享 Suno 标签页并勾选“共享标签页音频”，`MediaRecorder` 抓取该音频流；不是咪咪在服务端直接录。未勾选共享音频、或浏览器不支持时，必须明确提示，不许静默录成静音或切到麦克风。
兜底入口（同一空间，共用降噪/对比/导出链）：(1) 麦克风录音，可开关浏览器降噪/回声消除/自动增益，实时波形+电平表；(2) 上传已下载文件（wav/mp3/flac/m4a，≤80 MB/10 分钟，与 Audio Lab 口径一致）+ Suno 导入指引（suno-downloader，只下自己的歌、不问密码）。

## 5. 功能（口径无关的公共部分）

1. 录音库列表（聚合计数，不拉全文/大字段计数；加载失败有重试入口）。
2. 学噪声：选 1–2 秒纯噪声段，或自动取最安静帧；显示噪声谱快照。
3. 降噪强度滑块 0–100% 默认 50%，400 ms 防抖后重算，不阻塞播放；强度 0 = 原声（除必要的高通外不引入处理，需写明）。
4. 同响度 A/B：原声 vs 降噪后，切换播放位置不变，增益来自服务端/本地实测响度，差 <0.2 LU；默认先播处理后，注明“已按相同音量对比”。
5. 逼近原声数字：降噪前后信噪比变化、频谱距离、真峰值、削波数、静音段是否被放大（Audio Lab docs/02 G8 口径：静音段处理后仍 <-50 dBFS，开头 100 ms 不计）；超阈值警告并建议降强度。
6. 导出：WAV（44.1 kHz，Audio Lab 可直接上传）、MP3；附 denoise-report.json（噪声段位置、强度、SNR 前后、真峰值、警告）。
7. 送 Audio Lab：一键下载干净 WAV + 报告；页面写明下一步“去 Audio Lab 上传这支 WAV 选声音目标做增效”，不假装两空间已自动打通（无共享后端前不编造自动流转）。
8. 24 小时后自动删原始上传（抄 Audio Lab AGENTS.md 安全口径）；日志不记原始文件名。

## 6. 禁做清单

- 不许直连 Suno 账号拉曲库，不许问 Suno 密码，不许下别人的歌。
- 不许自称“AI 降噪模型”/“RNNoise 已接入”，除非真接了对应模型并给出证据；本期只做浏览器自带 + 谱减法/谱门，写明即是。
- 不许做多轨、混音、人声分离、修削波、音色转换（Audio Lab MVP 同样不做）。
- 不许在前端做假处理（原样返回冒充降噪）；做不到写明做不到。
- 不许首屏全加载：视图分割（React.lazy + Suspense）、非首屏音频 `loading="lazy"` + `preload="none"`/`metadata`（`lazy-load-video-and-audio` 规则：`<audio loading="lazy">` 必须带 `controls`，否则不可见、永不加载；Firefox/Safari 不支持该属性时靠 `preload` 兜底）、无外部字体 @import、列表查询按标签页门控。
- 不许编造“已和 Audio Lab 打通”的说法；不许编数字、编链接。

## 7. 机器可核验的验收标准

- [ ] 麦克风录音（口径 1/3）：Chrome 录 10 秒，波形实时推进，停后可播，导出 WAV ffprobe 为 44.1 kHz、时长误差 ≤10 ms。
- [ ] 导入（口径 2/3）：上传 wav/mp3/flac/m4a 各 2 秒测试音均成功，改扩展名文本文件拒收，>80 MB 拒收。
- [ ] 降噪：粉红噪声 + 1 kHz 正弦合成测试音，强度 50% 时噪声频段能量下降 ≥6 dB，1 kHz 频段变化 <1 dB；强度 0 与原声频谱差 <0.3 dB（高通除外，写明）。
- [ ] A/B 同响度：两段实测响度差 <0.2 LU；切换播放位置不变。
- [ ] 静音不放大：输入静音段处理后仍 <-50 dBFS（开头 100 ms 不计）。
- [ ] 无新增削波：输出 clipped_samples ≤ 输入。
- [ ] 导出 WAV 能直接上传 Audio Lab（格式/大小/时长口径一致），denoise-report.json 字段齐全。
- [ ] 懒加载审计：首屏音频总字节、JS 分块数、移动端 settle 时间实测记录；非首屏音频全 lazy；无外部字体。
- [ ] 沙盒过的只标沙盒；真机（Luca 手机/电脑录音 + 试听）未验的逐项列出，不写“已完成”。

## 8. modern-web-guidance 应用（建时执行）

- `lazy-load-video-and-audio`：非首屏 `<audio>` 加 `loading="lazy"` + `controls` + `preload="metadata"`；首屏播放器不加 lazy；“Lazy-loaded `<audio>` elements without `controls` are not rendered visibly and will never load or autoplay.”
- `accessibility`：原生 `<button>`/`<input type="range">`，滑块带 `aria-label`，状态变化走 `aria-live="polite"`，焦点可见，对比度 ≥4.5:1，触控目标 ≥44×44 px。

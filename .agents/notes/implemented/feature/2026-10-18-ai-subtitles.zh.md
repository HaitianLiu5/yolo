# Agent Note: 用用户自己的语音服务生成 AI 字幕

Status: implemented

[English](2026-10-18-ai-subtitles.md) | 中文

## 问题

用户看的很多内容没有他能读懂的语言的字幕。YouTube 上的日语直播在直播期间完全没有字幕；一场演讲或一段游戏视频可能只有说话人自己语言的字幕。用户希望在播放时从声音生成字幕并翻译，包括仍在进行的直播。

用户给了两个约束。除了已有的硬件之外不能再花钱：不要模型 API key，也不要按分钟计费，所以模型跑在家里的 Mac 上。而且这是高阶功能：可选，配置之前不启用，不配置时播放完全不变。Yolo 也不应该绑定某一个模型；跑什么由用户决定，换模型不应该改动 Yolo。

## 决策

在**媒体节点上新增两种可选插件**：**转写插件（transcriber）**把一段声音转成带时间的文字，**翻译插件（translator）**把若干行文字译成一种语言。加载了转写插件时，每个流都提供节点在播放过程中写出的 AI 字幕轨道；没有加载时，什么都不变。

```
screen ──GET /m/{token}/sub/{n}.vtt?start=&end=──▶ node ──ffmpeg──▶ 16 kHz WAV ──▶ transcriber ──▶ translator
   ▲                                                  │                         (the owner's speech server)
   └──────────── cues made so far, for the window ◀───┘
```

### 插件

插件在节点入口的工厂函数里调用 `yolo.registerTranscriber(id, { title?, transcribe })` 或 `yolo.registerTranslator(id, { language, title?, translate })`（[`@useyolo/plugin-api`](../../../../service/plugin-api/src/index.js)）；AI 字幕各用第一个注册的，插件启动失败时它们和插件的片源一起移除（[`service/node/src/speech.js`](../../../../service/node/src/speech.js)、[`plugins.js`](../../../../service/node/src/plugins.js)）。提问的[语音输入](2026-10-18-agent-from-the-screen.zh.md#voice-input)用同一个转录器处理屏幕的录音，直接调用，不排在 AI 字幕的队列后面。

- `transcribe({ audio, format: "wav", language, prompt, signal })` 收到最多 30 秒的 16 kHz 单声道 16 位 WAV、Yolo 已知时的说话语言（null 表示自行识别），以及由条目标题和前面最后几句话组成的提示，用来拼对人名。它返回 `{ language?, segments: [{ start, end, text }] }`，时间是从 `audio` 开头算起的秒数。Yolo 把片段裁到音频范围内，并丢掉空的片段。
- `detectLanguage({ audio, format: "wav", signal })` 可选，返回 `{ probabilities }`，即每种语言的可能性（0 到 1，按主语言子标签如 `zh`、`en` 作键），服务说不出时返回 null。[语音输入](2026-10-18-agent-from-the-screen.zh.md#voice-input)用它在用户说的几种语言里做选择；官方插件请求服务器的 `/audio/language`（OpenAI 的接口没有这个），遇到 404 后就不再请求。
- `translate({ lines, from, to, title, previous, signal })` 按顺序为每一行输入返回一行；`title` 和 `previous` 是上下文。`language` 是它翻译成的 BCP 47 语言标签，例如 `zh-Hans`，也是翻译轨道的名字。

由节点发起请求，不会有东西推给节点。每次调用 2 分钟后中止。

### 官方插件：OpenAI 的接口，任何模型

[`plugins/subtitles-openai`](../../../../plugins/subtitles-openai/) 使用大多数模型服务已经提供的两个 HTTP 接口，也就是 OpenAI 的：

- `POST {url}/audio/transcriptions`，multipart，带 `response_format=verbose_json` 和 `timestamp_granularities[]=segment`，以拿到片段时间，并带上 `X-Priority: realtime` 请求头，让同时处理批量任务的服务先处理等着字幕的屏幕。Whisper 自己判断为静音的片段（`no_speech_prob` 高于 0.6 且 `avg_logprob` 低于 −1）会被丢掉，因为 Whisper 在静音上会编出「感谢观看」之类的话。只回答 `text` 的服务会为整段给出一条字幕。
- `POST {translateUrl 或 url}/chat/completions`，要求回答一个字符串 JSON 数组，每行一个；无论数组出现在回复的哪里都能读出。

所以用户可以在任何地方跑任何模型，例如在家里的 MacBook Pro 上跑一个 Whisper 服务（例如 Speaches 或 MLX Whisper 服务）和一个本地语言模型（Ollama、LM Studio），换模型只是改选项。提供相同接口的托管服务也能用，按它自己的价格计费。`yolo.config.json` 中的选项：`url`（必填，例如 `http://mbp.local:8000/v1`）、`transcribeModel`（默认 `whisper-1`）、`translateUrl`、`translateModel`（不设则没有翻译插件，只有原文）、`language`（默认 `zh-Hans`），作为 Bearer token 发送的 `apiKey`（默认取 `SUBTITLES_OPENAI_API_KEY`），以及 `glossary`：术语和它们的译法，例如游戏黑话（ドライブラッシュ → 绿冲），可以是一个对象，也可以是 JSON 对象文件或制表符分隔文件的绝对路径。没有它，语言模型会按字面翻译格斗游戏的术语；每次请求只带上这些行和前面几行用到的条目，最多 40 条。这个插件不在 [`plugins/official.json`](../../../../plugins/official.json) 里；由用户自己加上，[`yolo.config.example.json`](../../../../yolo.config.example.json) 里有它，默认关闭。

### 节点上的增长轨道

[`service/node/src/ai-subtitles.js`](../../../../service/node/src/ai-subtitles.js) 在片源自己的字幕之后加两条轨道：译文（`ai-zh-Hans`，需要翻译插件）和原文（`ai-original`）。两条都是 `auto: true`、`delivery: "vtt"` 和 `growing: true`，照常从 `/m/{token}/sub/{n}.vtt` 提供，带 `no-store`（[媒体管线](../architecture/2026-10-11-node-media-pipeline.zh.md)）。

- **屏幕的窗口就是工作。**设备用 `?start=&end=`（秒）读取增长轨道：节点回答它在这个窗口里已有的字幕，并接着从窗口开头处理这个窗口。不带窗口时，节点回答目前做出的全部字幕，不做新的工作。时间是设备的字幕时间：固定时长条目从开头算起的秒数，或直播从 DVR 第一个分片算起的秒数。
- **固定长度的分块。**固定时长条目按 30 秒一块读取，这是 Whisper 自己的窗口。直播在分片发布之后，按加起来至少 15 秒的整数个分片读取；播放器落后直播边缘约 30 秒，所以一块的文字通常在屏幕播到那里之前就好了。
- **读取条目自己的声音，方式和会话相同**（[`media/audio.js`](../../../../service/node/src/media/audio.js)）。ffmpeg 从分块开头、带着 Input 的请求头读取：`file` Input 读它的 URL，`split` Input 读它的音频，`hls` Input 读它的音频 rendition（或第一个 variant）。直播的一块从会话的直播索引逐个取分片，再通过管道交给 ffmpeg。直播只有在 Input 带 `live` 时才提供 AI 轨道，因为这样才能读到它的分片。
- **一次一块，最新的屏幕优先。**节点上同一时间只转写一块、只翻译一块；最近被请求的条目优先，一分钟没人请求的条目不再处理。只有在有人读取译文轨道时才翻译。最近 8 个条目的字幕保存在内存里；不写磁盘。
- **失败。**失败的一块在 20 秒后、仍有屏幕请求时重试。在任何一块成功之前的失败会回答 `502 resolve_failed`「AI subtitles failed: …」并附上原因，例如语音服务连不上，让屏幕说一次；之后的失败安静地重试。

### 屏幕上

AI 轨道出现在字幕菜单里，带着每条 `auto` 轨道都有的 AI 标记：译文显示为该语言自己的名字，另一条是「Original」。选中后它像任何文字字幕一样加载；之后播放器每 4 秒再读一次，或在跳转超过 20 秒后立即读取，窗口从当前位置之前 10 秒到之后 90 秒，并把回答合并进已有的字幕（[`growing-subtitles.js`](../../../../clients/player/src/growing-subtitles.js)、[`subtitles.js`](../../../../clients/player/src/subtitles.js)）。两种引擎都像画其他文字字幕一样画它们，所以车里也有。读取失败的轨道在每个流里只提示一次原因。

## 考虑过的其他方案

**由 Yolo 调用托管的语音和翻译 API。**最简单，但每个用户都需要一个付费 key，Yolo 要保管它，而直播的声音按分钟计费。用户自己的服务不会多花钱，而提供 OpenAI 接口的托管服务仍然可以通过同一个插件使用。

**用户的 agent 插件（Claude Code）。**它有用户的登录，但既听不了声音，也给不了文字的时间；无论如何都要跑一个语音模型，而每 30 秒跑一次完整的 agent 来翻译太慢。

**流式接口，例如通过 WebSocket 的 OpenAI Realtime API。**延迟更低，但很少有本地服务实现它，直播本来就落后边缘 30 秒，而分块的 HTTP 请求更容易重试，也能在任何服务上跑。流式的转写服务仍然可以做成同一类插件。

**由 Yolo 定义一个 HTTP 协议，让 Mac 去实现。**同样与模型无关，但每个服务都要写一个适配层。OpenAI 的接口是大多数服务已经支持的事实标准；Yolo 自己的接口是插件 API，所以另一种协议就是另一个插件。

**在浏览器里识别（Web Speech API）。**它听的是麦克风而不是页面的声音，车里用不了，还会把语音发给浏览器厂商。

**通过实时通道推送字幕。**这样字幕一生成屏幕就能知道，但 Hub 要为每块屏幕转发文字；按窗口读取让工作按需进行，控制面和节点之间也不需要新东西。

## 影响

用户可以为任何有声音的条目，包括直播，得到自己语言的字幕，用的是自己在家里选的模型，Yolo 不保存任何模型凭据。质量和速度取决于用户的模型。屏幕开始请求后，第一批字幕要等一块的时长加上它的转写时间，节点没听过的条目开始时是空的。转写和翻译各只有一条通道，两块屏幕播放不同条目时共用语音服务。已知的不足：已保存的字幕偏好不会选中 AI 轨道，因为片源在它们出现之前就做了选择；分片为 fMP4、需要 init 分片的直播没有 AI 轨道；iPhone 自带的全屏播放器只显示打开时已加载的字幕。

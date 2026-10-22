# Agent Note: AI subtitles from the owner's own speech services

Status: implemented

English | [中文](2026-10-18-ai-subtitles.zh.md)

## Problem

Much of what the owner watches has no subtitles in a language they read. A Japanese live stream on YouTube has no captions at all while it is live; a talk or a game video may have only the speaker's own language. The owner wants subtitles made from the sound and translated, while the item plays, including a live stream that is still going.

Two constraints come from the owner. It must cost nothing beyond hardware they already have: no model API key and no per-minute bill, so the models run on a Mac at home. And it is an advanced feature: optional, off until configured, with playback unchanged without it. Yolo should not depend on any one model either; the owner picks what runs, and changing it should not change Yolo.

## Decision

Two new **optional plugin types on the media node**: a **transcriber** turns a stretch of sound into timed text, and a **translator** turns lines of text into one language. With a transcriber loaded, every stream offers AI subtitle tracks that the node writes while the item plays; without one, nothing changes.

```
screen ──GET /m/{token}/sub/{n}.vtt?start=&end=──▶ node ──ffmpeg──▶ 16 kHz WAV ──▶ transcriber ──▶ translator
   ▲                                                  │                         (the owner's speech server)
   └──────────── cues made so far, for the window ◀───┘
```

### The plugins

A plugin calls `yolo.registerTranscriber(id, { title?, transcribe })` or `yolo.registerTranslator(id, { language, title?, translate })` in its node factory ([`@useyolo/plugin-api`](../../../../service/plugin-api/src/index.js)); AI subtitles use the first of each registered, and a failed start removes them with the plugin's sources ([`service/node/src/speech.js`](../../../../service/node/src/speech.js), [`plugins.js`](../../../../service/node/src/plugins.js)). Ask's [voice input](2026-10-18-agent-from-the-screen.md#voice-input) uses the same transcriber for a screen's recording, called directly rather than behind AI subtitles' lane.

- `transcribe({ audio, format: "wav", language, prompt, signal })` gets at most 30 seconds of 16 kHz mono 16-bit WAV, the spoken language when Yolo knows it (null: detect it), and a prompt of the item's title and the last words before, for names. It resolves `{ language?, segments: [{ start, end, text }] }`, seconds from the start of `audio`. Yolo clips segments to the audio and drops empty ones.
- `translate({ lines, from, to, title, previous, signal })` resolves one line per input line, in order; `title` and `previous` are context. `language` is the BCP 47 tag it translates into, such as `zh-Hans`, and names the translated track.

The node asks; nothing is pushed to it. Each call is aborted after 2 minutes.

### The official plugin: OpenAI's interfaces, any model

[`plugins/subtitles-openai`](../../../../plugins/subtitles-openai/) speaks the two HTTP interfaces most model servers already offer, OpenAI's:

- `POST {url}/audio/transcriptions`, multipart, with `response_format=verbose_json` and `timestamp_granularities[]=segment`, for the segment times, and the header `X-Priority: realtime`, so a server that also serves batch work can put a waiting screen first. Segments Whisper itself judges silence (`no_speech_prob` above 0.6 with `avg_logprob` below −1) are dropped, since Whisper invents words such as "thanks for watching" on silence. A server that answers only `text` gives one cue for the stretch.
- `POST {translateUrl or url}/chat/completions`, asking for a JSON array of strings, one per line; the array is read wherever it sits in the reply.

So the owner runs what they like where they like, for example a Whisper server (such as Speaches or an MLX Whisper server) and a local language model (Ollama, LM Studio) on a MacBook Pro at home, and switching models is a change of options. A hosted service with the same interfaces also works, at its own price. Options in `yolo.config.json`: `url` (required, such as `http://mbp.local:8000/v1`), `transcribeModel` (default `whisper-1`), `translateUrl`, `translateModel` (without it, no translator and only the original words), `language` (default `zh-Hans`), `apiKey` (default `SUBTITLES_OPENAI_API_KEY`), sent as a Bearer token, and `glossary`, terms and their translations, such as a game's jargon (ドライブラッシュ → 绿冲), given as an object or the absolute path of a JSON object or a tab-separated file. A language model translates a fighting game's terms literally without it; each request carries only the entries its lines and the lines before use, at most 40. The plugin is not in [`plugins/official.json`](../../../../plugins/official.json); the owner adds it, and [`yolo.config.example.json`](../../../../yolo.config.example.json) has it disabled.

### Growing tracks on the node

[`service/node/src/ai-subtitles.js`](../../../../service/node/src/ai-subtitles.js) adds two tracks after the source's own: the translation (`ai-zh-Hans`, with a translator) and the original words (`ai-original`). Both are `auto: true`, `delivery: "vtt"`, and `growing: true`, and are served at the usual `/m/{token}/sub/{n}.vtt` with `no-store` ([media pipeline](../architecture/2026-10-11-node-media-pipeline.md)).

- **The screen's window is the work.** A device reads a growing track with `?start=&end=` (seconds): the node answers the cues it has in that window and works on the window next, from its start. Without a window it answers every cue made so far and does no work. Times are the device's subtitle times: seconds into a fixed-length item, or seconds since the first segment of a live stream's DVR.
- **Chunks of fixed length.** A fixed-length item is read in 30-second chunks, Whisper's own window. A live stream is read in whole segments adding up to at least 15 seconds, once they are published; the player sits about 30 seconds behind the live edge, so a chunk's text is usually ready before the screen gets there.
- **Its own sound, read as the session reads it** ([`media/audio.js`](../../../../service/node/src/media/audio.js)). ffmpeg reads a `file` Input from its URL, a `split` Input's audio, or an `hls` Input's audio rendition (or first variant), from the chunk's start, with the Input's headers. A live stream's chunk is fetched segment by segment from the session's live index and piped to ffmpeg. A live stream offers AI tracks only when its Input has `live`, since that is how its segments are read.
- **One at a time, the latest screen first.** One chunk is transcribed and one translated at a time on the node; the item most recently asked about goes first, and an item nobody asked about for a minute gets no more work. Translation runs only while someone reads the translated track. The last 8 items keep their cues in memory; nothing is written to disk.
- **Failures.** A failed chunk is tried again after 20 seconds while a screen still asks. A failure before any chunk worked answers `502 resolve_failed` "AI subtitles failed: …" with the cause, such as a speech server that cannot be reached, so the screen can say it once; later failures are retried quietly.

### On the screen

AI tracks appear in the subtitle menu with the AI badge every `auto` track has: the translation under its language's own name, and "Original". Choosing one loads it like any text subtitle; then the player reads it again every 4 seconds, or at once after a seek of more than 20 seconds, for the window from 10 seconds behind to 90 seconds ahead of its position, and merges the answer into the cues it has ([`growing-subtitles.js`](../../../../clients/player/src/growing-subtitles.js), [`subtitles.js`](../../../../clients/player/src/subtitles.js)). Both engines draw them as they draw every text subtitle, so the car gets them too. A track that fails to read shows its message once per stream.

## Alternatives considered

**Yolo calling a hosted speech and translation API.** Simplest, but every owner needs a paid key, Yolo holds it, and minutes of live sound cost money. The owner's own server costs nothing more, and a hosted service with OpenAI's interfaces still works through the same plugin.

**The owner's agent plugin (Claude Code).** It has the owner's login, but it neither hears audio nor times words; a speech model has to run anyway, and a translation through a whole agent run per 30 seconds is slow.

**A streaming interface, such as OpenAI's Realtime API over WebSocket.** Lower latency, but few local servers implement it, the stream already plays 30 seconds behind its edge, and chunked HTTP requests are easier to retry and to run on any server. A streaming transcriber can still be a plugin of the same type.

**A Yolo-defined HTTP protocol for the Mac to implement.** Model-independent, but every server would need an adapter. OpenAI's interfaces are the de facto standard most servers already speak; Yolo's own interface is the plugin API, so another protocol is another plugin.

**Recognition in the browser (Web Speech API).** It hears the microphone, not the page's audio, is unavailable in the car, and sends speech to the browser vendor.

**Pushing cues over the realtime channel.** It would tell screens the moment a cue exists, but the Hub would carry text for every screen; reading a window keeps the work on demand and needs nothing new between the control plane and the node.

## Consequences

The owner gets subtitles in their language for any item with sound, live streams included, from models of their choosing at home, and Yolo stores no model credential. Quality and speed are the owner's models'. The first cues come one chunk plus its transcription after the screen starts asking, and an item the node has not heard before starts empty. With one lane each, two screens playing different items share the speech server. Known gaps: AI tracks are not chosen by saved subtitle preferences, since the source chooses before they exist; a live stream of fMP4 segments, which need their init segment, has none; and iPhone's own fullscreen player shows only the cues loaded when it opened.

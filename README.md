# ReDub

本地优先的 AI 配音工作室：导入视频、音频或台词，分离人声与背景，逐句校对、翻译、配音、合并并导出成片。

## 开发

```bash
npm install
cp .env.example .env
npm run dev
```

`npm run dev` 会启动 Electron 开发窗口及其 Nuxt 热更新服务，自动选择空闲端口；退出开发窗口会一并停止服务。素材和 SQLite 数据会保存在 `.data/`。API Key 优先在应用左下角的「设置」中填写并保存，也可用 `.env` 作为兼容配置。

本地人声分离和台词识别需要一次安装 Python 运行环境：

```bash
npm run models:install
```

首次使用 Demucs / Whisper 模型时会下载模型文件。视频处理需要本机可用的 FFmpeg；开发环境会优先使用项目依赖中的二进制，也可用 `REDUB_FFMPEG`、`REDUB_FFPROBE` 指定路径。

## 使用流程

1. 新建项目，导入视频、音频、TXT、SRT 或 VTT；普通文本也可以直接粘贴。导入只建立项目，不会自动创建后续任务。
2. 音视频项目点击“识别台词 / 处理素材”后，应用只在本机提取音轨、分离人声与背景、切分片段并识别台词。识别结果先停在台词校对区，不会自动翻译或生成配音；中文识别结果统一为简体中文，其他语言保留原语言。
3. 在台词工作区校对时间、原文和译文。翻译需要手动点击“翻译台词”，会调用已配置的翻译接口并消耗额度。
4. 每句台词都可以单独打开生成设置并生成配音，也可以点击“批量配音”统一生成。AI 配音默认调用火山 Audio `seed-audio-1.0`；微软 TTS 选项无需 API Key，但需要网络连接。音视频项目使用原声参考前必须完成人声分离。
5. 配音完成后，在“预览成片”中手动合成；合成只替换开启的片段，空白区间保留背景 / 原始音轨，并对生成语音自动做时长对齐。确认后导出视频、音频和 SRT 字幕。

所有处理任务（包括同步翻译、AI / 微软 TTS 配音、预览音轨准备与导出）先写入本地 SQLite 并获得独立任务 ID，再由后台队列执行。刷新页面不会取消任务；右下角任务管理器可查看详情与全部历史任务，详情链接刷新后仍可恢复。

任务详情包含状态、参数、结果、错误与每次重试的网络记录。可展开查看请求地址、方法、请求头、完整请求体、响应头、响应体、状态码、时间与耗时，复制 curl 或下载完整 JSON 记录。密钥在日志中隐藏，curl 使用渠道的密钥环境变量；微软 TTS 记录 WebSocket 消息帧，其 curl 用于复现握手。大内容默认折叠，完整内容仍可展开与下载。此前完成的历史任务无法补录网络记录。

导出完成后可从任务详情重新下载。失败任务会暂停当前项目，可在任务管理器重试或跳过。应用重启后，正在执行的任务与请求会标记为中断，已完成片段会复用；同步上游接口中断后无法恢复其连接，需手动重试。

## 配置渠道

在应用左下角打开「设置」，进入「AI 渠道」即可添加或编辑渠道并填写 API Key。密钥只保存在本机 SQLite 中，编辑已有渠道时留空不会覆盖原密钥。也可以使用 `.env` 作为兼容配置：

```dotenv
VOLCENGINE_API_KEY=your-volcengine-key
TRANSLATION_API_KEY=your-openai-compatible-key
TRANSLATION_BASE_URL=https://api.openai.com/v1
TRANSLATION_MODEL=gpt-4o-mini
```

自定义渠道的 Key 环境变量名必须以 `_API_KEY` 结尾。不要把 `.env`、素材或 `.data/` 提交到 Git。

## 桌面版

```bash
npm run desktop:pack
npm run desktop:dist
```

桌面版为 Electron 本地壳，服务固定监听回环地址并使用一次性会话令牌；渲染进程无 Node 权限，导航和媒体路径经过限制。安装版可在设置中点击「安装模型环境」（需 Python 3.11），或用 `REDUB_PYTHON` 指向已有虚拟环境。

正式发布前：

- 在环境变量中设置 `REDUB_UPDATE_URL=https://...`，让 electron-builder 生成通用更新源配置。
- 网页热更新包可通过 `scripts/web-bundle.mjs` 在发布环境生成；桌面端配置对应 `REDUB_WEB_UPDATE_URL` 和 `REDUB_WEB_PUBLIC_KEY`。
- macOS 签名、公证、Windows 签名和更新服务器托管属于发布环境工作，当前仓库不包含生产证书。

## 检查

```bash
npm run typecheck
npm test
npm run test:integration
npm run build
# 本地台词识别规则测试（不下载 Whisper 模型）
.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v
```

媒体管线测试会生成短视频和 WAV，校验未替换区间、背景保留、配音替换与最终导出；测试数据位于临时目录。`docs/IMPLEMENTATION.md` 记录需求与验收边界。

## 验证状态与限制

当前生成的安装包面向 macOS Apple Silicon，位于 `release/ReDub-0.1.0-arm64.dmg`，尚未签名和公证。Windows / Linux 打包配置已提供，需在对应平台构建验收。

本地模型已经用短语音验证；付费 API 使用模拟协议响应做自动测试，真实 Key 由使用者填写后联调。源分离可能残留人声或影响背景，参考音色和变速也受模型质量限制，不能保证所有影视片段完全无损或音色绝对一致。请在成片前逐句试听。

# ReDub

本地优先的 AI 配音工作室：导入视频、音频或台词，分离人声与背景，逐句校对、翻译、配音、合并并导出成片。

## 开发

```bash
npm install
cp .env.example .env
npm run dev
```

`npm run dev` 会启动 Electron 开发窗口及其 Nuxt 热更新服务，自动选择空闲端口；退出开发窗口会一并停止服务。素材和 SQLite 数据会保存在 `.data/`，API Key 只从 `.env` 读取。

本地人声分离和台词识别需要一次安装 Python 运行环境：

```bash
npm run models:install
```

首次使用 Demucs / Whisper 模型时会下载模型文件。视频处理需要本机可用的 FFmpeg；开发环境会优先使用项目依赖中的二进制，也可用 `REDUB_FFMPEG`、`REDUB_FFPROBE` 指定路径。

## 使用流程

1. 新建项目，导入视频、音频、TXT、SRT 或 VTT；普通文本也可以直接粘贴。
2. 视频依次执行音轨提取、人声与背景分离、人声分段、台词识别；音频从人声分离开始，文本从翻译开始。
3. 在台词工作区修改时间、原文、译文和替换开关。每次修改后可单独生成该片段。
4. 翻译通过 OpenAI 兼容渠道完成；AI 配音默认调用火山 Audio `seed-audio-1.0`，参考音频使用人声片段。
   音视频项目必须先完成人声分离；手动片段和丢失的参考文件会在配音前自动截取。重新分离成功后保留台词与时间编辑，清除旧参考、配音和成片，需重新生成。
5. 音轨合并时只替换开启的片段，空白区间保留背景 / 原始音轨，并对生成语音自动做时长对齐。
6. 在原始素材与配音成片之间切换试听，导出视频、音频和 SRT 字幕。

失败任务会暂停当前项目，可在右下角任务管理器重试或跳过。应用重启后，正在执行的任务会标记为失败，已完成片段会复用。

## 配置渠道

在「渠道与设置」中查看渠道。把对应 Key 写入 `.env` 后重启：

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

桌面版为 Electron 本地壳，服务固定监听回环地址并使用一次性会话令牌；渲染进程无 Node 权限，导航和媒体路径经过限制。首次启动会在系统应用数据目录创建 `.env`，方便正式安装版配置 Key。macOS 默认路径为 `~/Library/Application Support/redub/.env`。安装版可在设置中点击「安装本地模型环境」（需 Python 3.11），或用 `REDUB_PYTHON` 指向已有虚拟环境。

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
```

媒体管线测试会生成短视频和 WAV，校验未替换区间、背景保留、配音替换与最终导出；测试数据位于临时目录。`docs/IMPLEMENTATION.md` 记录需求与验收边界。

## 验证状态与限制

当前生成的安装包面向 macOS Apple Silicon，位于 `release/ReDub-0.1.0-arm64.dmg`，尚未签名和公证。Windows / Linux 打包配置已提供，需在对应平台构建验收。

本地模型已经用短语音验证；付费 API 使用模拟协议响应做自动测试，真实 Key 由使用者填写后联调。源分离可能残留人声或影响背景，参考音色和变速也受模型质量限制，不能保证所有影视片段完全无损或音色绝对一致。请在成片前逐句试听。

# 日语电影 AI 配音交付审查

目标场景：导入一部日语电影，识别日语对白，翻译为中文，替换原演员人声，保留背景音乐与环境声，合成可交给领导播放的视频，并能在返工时保持结果可追溯。

结论：当前项目适合做短片和流程演示，还不适合直接承担整部电影的交付。主要风险集中在“导出文件不是最终文件”“未完成对白可能混入原日语”“长片无法稳定跑完”“音色与角色不稳定”“没有交付验收和版本冻结”。

## P0：交差前必须先修

### 1. 页面上的“导出成片”可能下载的是预览文件，不是最终导出文件

- `pipeline.ts` 的 preview 阶段会写入 `projects.outputPath`，视频文件名是 `dubbed-*.mp4`：[server/services/pipeline.ts:362-399](/Users/yhg/i/redub/server/services/pipeline.ts:362)。
- 工作区和首页只要看到 `outputPath` 就显示“导出成片”或“可导出”：[app/components/ProjectWorkspace.vue:683-689](/Users/yhg/i/redub/app/components/ProjectWorkspace.vue:683)、[app/pages/index.vue:202-209](/Users/yhg/i/redub/app/pages/index.vue:202)。
- 真正的 `/export` 只返回任务结果，没有把最终 MKV/MP4/WAV 写回项目的最终交付字段：[server/services/export.ts:69-141](/Users/yhg/i/redub/server/services/export.ts:69)。
- 重新打开项目后，用户可能下载旧预览 MP4，以为已经拿到最终交付文件。

建议：区分 `previewPath` 和 `finalExportPath`；导出成功后保存格式、音轨选择、字幕版本、文件大小、SHA-256 和导出时间。页面上的下载按钮只指向最终交付文件。

### 2. “优化合成”允许未完成的对白保留日语原声，仍可导出

- 只有勾选单独“配音”音轨时，导出才阻止缺少配音的片段：[server/services/export.ts:73-77](/Users/yhg/i/redub/server/services/export.ts:73)。
- “优化合成”在缺少配音时会保留原始音轨；代码还明确把未生成片段描述为“保留原声”：[server/services/preview-tracks.ts:404-415](/Users/yhg/i/redub/server/services/preview-tracks.ts:404)。
- 这意味着某句配音失败或被跳过时，成片可能混入日语原演员声音，而用户仍能生成一个看似完成的交付文件。

建议：增加“全片替换模式”。交付模式下只要有启用片段未生成、失败、跳过或未审核，就禁止导出；若确实允许保留原声，必须在导出前列出时间码、台词和原因，并在交付报告中标记。

### 3. 非视频项目试听会叠加原声和选中的预览轨

- 音频项目的时钟播放器使用原始 `sourcePath/audioPath`，文本项目使用优化音轨：[app/components/ProjectWorkspace.vue:137-146](/Users/yhg/i/redub/app/components/ProjectWorkspace.vue:137)。
- 时钟播放器触发 `onClockPlay` 后，又会播放勾选的预览轨：[app/components/ProjectWorkspace.vue:254-269](/Users/yhg/i/redub/app/components/ProjectWorkspace.vue:254)、[app/components/ProjectWorkspace.vue:280-283](/Users/yhg/i/redub/app/components/ProjectWorkspace.vue:280)。
- 视频元素有 `muted`，但非视频隐藏的 `audio` 没有静音属性：[app/components/ProjectWorkspace.vue:935-947](/Users/yhg/i/redub/app/components/ProjectWorkspace.vue:935)。

建议：时钟播放器必须始终静音，只负责时间同步；试听声音只能来自勾选的音轨。修复后要用“全关、只听配音、只听优化合成”三种状态实际试听。

### 4. 配音过长时会静默截尾

- 生成音频超过台词时间时，最多只加速到 1.2 倍，随后用 `atrim=0:duration` 强制裁切：[server/services/media.ts:191-207](/Users/yhg/i/redub/server/services/media.ts:191)。
- 任务会显示完成，但台词尾字可能已经消失。隔离实测已确认尾部音调被截掉。

建议：超过可接受变速范围时任务失败并要求扩展时间段、缩短译文或重新生成；至少在片段上显示“可能被裁剪”，禁止静默成功。

### 5. 多音轨电影无法选择日语对白轨

- `probe` 只返回时长和是否含视频，不返回音轨语言、标题、声道等信息：[server/services/media.ts:144-156](/Users/yhg/i/redub/server/services/media.ts:144)。
- `extractAudio` 没有 `-map` 或音轨选择参数，遇到多音轨文件可能取错旁白、评论音轨或其他语言：[server/services/media.ts:158-160](/Users/yhg/i/redub/server/services/media.ts:158)。
- 对日本电影尤其危险：有些片源包含日语原声、英语配音、解说或 5.1 多声道。

建议：导入后显示所有音轨的语言、标题、声道布局和默认标记，让用户明确选择“日语对白轨”；同时支持保留原始多声道信息。

### 6. 长配音批处理会串行且一条失败阻塞后面全部片段

- 批量配音把每个片段串成一条依赖链，后一个任务依赖前一个任务：[server/services/queue.ts:63-74](/Users/yhg/i/redub/server/services/queue.ts:63)。
- 因此即使全局并发设置为 2–8，同一部电影的对白仍基本逐句串行；一条网络失败还会阻塞后续所有任务。
- 整部电影几百句对白时，处理时间和返工成本都会放大。

建议：片段配音任务按并发独立执行；失败句不阻塞其他句，最后汇总失败清单。合成阶段再等待全部目标片段并生成缺口报告。

## P1：影响整片效率和交付可信度

### 7. 整部电影很可能超过一小时，被强制杀死且无法续跑

- 所有外部进程默认 60 分钟超时，超时后直接 `SIGKILL`：[server/services/media.ts:40-75](/Users/yhg/i/redub/server/services/media.ts:40)。
- 人声分离固定使用 CPU 的 Demucs：[server/services/pipeline.ts:63-75](/Users/yhg/i/redub/server/services/pipeline.ts:63)。
- Whisper 对每个片段串行识别，阶段结束前才整体写回结果，没有按场景或片段断点：[scripts/audio.py:40-52](/Users/yhg/i/redub/scripts/audio.py:40)、[server/services/pipeline.ts:132-179](/Users/yhg/i/redub/server/services/pipeline.ts:132)。

建议：按章节或 5–15 分钟分块；每个片段完成即落库；支持断点续做、GPU/MPS/CUDA 选择、预计剩余时间和取消任务。先用目标机器跑 5 分钟和 30 分钟基准，再决定整片参数。

### 8. 日语识别缺少上下文、置信度和复核队列

- Whisper 对每个切出的短音频独立识别，并关闭前文条件：[scripts/audio.py:9-29](/Users/yhg/i/redub/scripts/audio.py:9)。
- 只有 VAD 时间和文本，没有置信度、候选结果、日语人名/专名标记。
- 快速对白、重叠对白、低声对白、音乐盖住的句子容易识别错，用户无法快速找到疑似错误句。

建议：按场景或连续对白识别，再映射回片段；保存置信度和词级时间；建立“待复核”列表，优先展示低置信度、空文本和异常短/长片段。

### 9. 导入时没有提交源语言，误识别后也没有真正的重新识别流程

- 导入界面只提交文件、项目名和目标语言，不提交 `sourceLanguage`：[app/components/ImportProject.vue:31-42](/Users/yhg/i/redub/app/components/ImportProject.vue:31)。
- 项目首次默认使用 `auto`；之后修改为日语只会清理翻译/配音，不会自动重新跑识别：[server/api/[...path].ts:151-170](/Users/yhg/i/redub/server/api/[...path].ts:151)。
- 对日语电影，第一次自动检测不稳定时，用户只能重新导入或手工改全文。

建议：导入时就选择“日语”；修改源语言后提供“重新识别并保留时间轴 / 保留人工文本”两个选项。

### 10. 没有说话人分离和角色级固定音色

- 当前只有 VAD + Whisper，没有 diarization；片段默认角色是“角色 1”：[scripts/audio.py:38-49](/Users/yhg/i/redub/scripts/audio.py:38)、[server/db/schema.ts:29-39](/Users/yhg/i/redub/server/db/schema.ts:29)。
- 角色名称主要靠人工修改；多人电影中逐句分配角色会非常耗时，也容易错。
- 每句 AI 请求只使用该句参考音频，没有角色级固定参考/voice profile，句与句之间可能音色漂移：[server/services/providers.ts:126-140](/Users/yhg/i/redub/server/services/providers.ts:126)。
- 先用“角色音色”设置，再批量配音时，共用参数会覆盖目标片段的音色设置：[app/components/BatchProcessing.vue:21-26](/Users/yhg/i/redub/app/components/BatchProcessing.vue:21)、[server/services/queue.ts:79-90](/Users/yhg/i/redub/server/services/queue.ts:79)。

建议：增加角色表、5–20 秒清洁参考、固定 voice profile、角色批量试音和逐角色生成；批量生成时保留每句已有角色配置，不能用一个全局 voice 覆盖整部电影。

### 11. 翻译没有全片上下文、角色表和术语表

- 翻译每 20 句分批请求，提示词没有场景上下文、角色关系、专名表或已锁定译法：[server/services/providers.ts:50-109](/Users/yhg/i/redub/server/services/providers.ts:50)。
- 只校验返回条数、非空和长度，不检查人名、地名、专有名词和称谓是否统一。
- 日语电影中敬语、称呼、口癖和专名容易前后漂移；“严格不超时”的字数限制也可能过度压缩台词语气。

建议：先建立人物表和术语表；按场景翻译；允许锁定人工译文；显示翻译前后差异；把“口语自然度”和“时长适配”分开审核。

### 12. 日语 TTS 的 SSML 语言写死为英文

- Edge TTS 生成的 SSML 固定 `xml:lang='en-US'`：[server/services/edge-speech.ts:40-43](/Users/yhg/i/redub/server/services/edge-speech.ts:40)。
- 即使选择日语或中文声音，也可能影响发音和韵律。

建议：根据选定 voice 自动映射 `ja-JP`、`zh-CN` 等语言，并用日语短句做真实试听验收。AI 配音与微软 TTS 都应显示实际语言和声音配置。

另外，微软 TTS 的默认音色是中文晓晓；如果用户没有手动改声音，目标语言设置不会自动切换音色：[shared/voice.ts:23-38](/Users/yhg/i/redub/shared/voice.ts:23)。AI 配音提示词也没有把目标语言作为明确的发音约束传入：[server/services/providers.ts:140-141](/Users/yhg/i/redub/server/services/providers.ts:140)。日语电影应在生成前检查“目标语言—音色语言”一致性。

### 13. 缺少响度、动态和原声泄漏验收

- 混音主要是 `amix normalize=0` 加限制器，没有对白响度目标、背景 ducking、LUFS/True Peak 检查：[server/services/pipeline.ts:282-301](/Users/yhg/i/redub/server/services/pipeline.ts:282)、[server/services/export.ts:117-125](/Users/yhg/i/redub/server/services/export.ts:117)。
- Demucs 后可能残留日语人声；不同句子的 AI 音量也可能忽大忽小。
- 交付给领导时，最容易被听出来的是对白忽大忽小、背景断裂、原声残留和替换区突变。

建议：加入对白/背景响度标准化、短暂 ducking、True Peak 限制、替换区首尾淡入淡出，并自动输出 LUFS、峰值、静音区和原声泄漏警告。

### 14. 缺少背景音时，预览可用但正式合成路径不一致

- 优化预览在没有背景音时会直接使用配音或原声：[server/services/preview-tracks.ts:232-239](/Users/yhg/i/redub/server/services/preview-tracks.ts:232)。
- 批量“合成成片”对媒体项目又要求背景音存在：[shared/batch.ts:35-42](/Users/yhg/i/redub/shared/batch.ts:35)。
- 用户可能先听到一个“可以”的预览，到了交付步骤才发现不能正式合成，或替换区环境声已经消失。

建议：预览标记为“试听草稿”，缺背景时禁止显示“可交付”；正式合成前明确检查背景轨和人声轨均可用。

### 15. 重叠对白没有统一处理，后句会被压缩、推迟或跳过

- 保存片段时只检查是否超出素材，不检查与其他片段重叠：[server/api/[...path].ts:428-436](/Users/yhg/i/redub/server/api/[...path].ts:428)。
- 正式合成和预览都用 `Math.max(cursor, line.start)` 推进时间轴：[server/services/pipeline.ts:334-347](/Users/yhg/i/redub/server/services/pipeline.ts:334)、[server/services/preview-tracks.ts:266-288](/Users/yhg/i/redub/server/services/preview-tracks.ts:266)。
- 多人抢话、重叠对白是电影常见情况，当前结果可能吞掉后句或改变原始时间关系。

建议：默认保存时拒绝重叠并提示；若要支持抢话，必须提供明确的多轨混音模式，而不是隐式压缩。

### 16. 渠道、语言和设置修改会让既有成果失效，且缺少版本保护

- 保存渠道会清空所有关联项目的 `generatedPath/generatedHash`，即使只是改名或重复保存；还可能误伤微软 TTS 片段：[server/api/[...path].ts:87-114](/Users/yhg/i/redub/server/api/[...path].ts:87)。
- 项目设置改目标语言或 AI 渠道会清空译文/配音/成片：[server/api/[...path].ts:151-170](/Users/yhg/i/redub/server/api/[...path].ts:151)。
- 没有项目快照、版本冻结和回滚；当前台词和设置是可变状态。

建议：把脚本、翻译、角色配置、音色配置、模型/渠道和导出参数做成可命名版本；交付版本锁定后，后续实验生成新版本，不覆盖已交付结果。

### 17. 失败任务的“跳过”会静默改变交付内容

- 跳过配音任务时，未生成的片段会被设为 `enabled=false`：[server/api/[...path].ts:401-410](/Users/yhg/i/redub/server/api/[...path].ts:401)。
- UI 文案是“保留原声并跳过”，但导出并不会强制生成缺口报告。
- 对电影交付来说，这会把“有一句没配好”变成“看起来成功但实际保留日语原声”。

建议：跳过必须留下不可忽略的缺口标记；交付模式禁止存在跳过项，或自动生成带时间码的缺口清单并要求明确选择。

### 18. 长片临时文件和磁盘预算不足

- 分离会留下原始 WAV、Demucs stems、每句 reference/voice；合成还会生成大量 chunk/aligned/concat 文件：[server/services/pipeline.ts:55-103](/Users/yhg/i/redub/server/services/pipeline.ts:55)、[server/services/pipeline.ts:273-351](/Users/yhg/i/redub/server/services/pipeline.ts:273)。
- `localModel` 写入的输入 JSON 没有清理：[server/services/media.ts:209-214](/Users/yhg/i/redub/server/services/media.ts:209)。
- 没有导入前剩余空间检查、临时文件清理、项目归档和缓存管理。

建议：导入前估算至少 2–4 倍源文件空间；临时文件按任务生命周期清理；提供“保留源/保留最终结果/清理中间文件”的归档操作。

### 19. 无法取消正在运行的长任务

- UI 的“暂停任务”只阻止后续调度，不会终止已经运行的 FFmpeg、Demucs 或 Whisper；媒体进程只在应用退出时统一停止：[server/services/media.ts:37-38](/Users/yhg/i/redub/server/services/media.ts:37)、[app/components/ProjectWorkspace.vue:590-599](/Users/yhg/i/redub/app/components/ProjectWorkspace.vue:590)。
- 长片误选模型或参数错误时，只能等任务跑完或强制退出应用。

建议：增加取消任务状态；终止对应子进程；安全删除 partial 文件并保留已完成片段。

### 20. 导出视频的 MP4 兼容性没有保证

- 导出 MP4 时只复制原视频流，实际使用 `-c:v copy`：[server/services/export.ts:120-125](/Users/yhg/i/redub/server/services/export.ts:120)。
- 如果源视频是 HEVC、VP9、AV1、10-bit 或特殊 MKV 封装，生成的 MP4 可能无法在领导电脑播放。

建议：提供“兼容 MP4（H.264 / yuv420p / AAC）”和“无损 MKV”两个明确预设；导出前显示源编码、分辨率、帧率和预计文件大小。

### 21. AVI 允许导入但导出路径不支持

- 导入白名单包含 AVI：[server/services/importer.ts:19-34](/Users/yhg/i/redub/server/services/importer.ts:19)。
- 导出路径白名单缺少 AVI：[server/services/export.ts:30-35](/Users/yhg/i/redub/server/services/export.ts:30)。
- 隔离实测确认 AVI 可以导入，但视频导出任务失败。

建议：统一格式能力；如果暂不支持 AVI，就在导入阶段明确拒绝并说明可转换格式。

## P1：交付能力还缺什么

### 22. 没有成片自动质量验收

`exportProject` 生成文件后直接改名返回，没有再用 ffprobe 检查视频/音频流、时长、采样率、声道、编码、峰值和尾部完整性：[server/services/export.ts:130-141](/Users/yhg/i/redub/server/services/export.ts:130)。

建议：导出后自动生成验收报告，至少包括：

- 视频和音频时长差；
- 视频编码、分辨率、帧率、音频编码、采样率、声道；
- LUFS、True Peak、最大静音段；
- 未配音/跳过/低置信度片段；
- 字幕覆盖率和字幕版本；
- 输出文件 SHA-256。

### 23. 没有“一键交付包”和 manifest

当前 UI 主要下载单个视频和外挂 SRT：[app/components/ProjectWorkspace.vue:1117-1138](/Users/yhg/i/redub/app/components/ProjectWorkspace.vue:1117)。

建议一键生成目录或 ZIP，包含：

- 最终兼容 MP4；
- 无损或备份 MKV；
- 外挂 SRT，必要时提供内嵌字幕版本；
- 配音混合 WAV、背景 WAV、原声/对比音轨；
- 台词表（时间码、日文原文、中文译文、角色、审核状态）；
- 质量验收报告；
- 模型、渠道、参数、版本和文件哈希 manifest。

### 24. 没有双音轨、内嵌字幕和纯音轨交付预设

- 导出只 map 一个混合音轨和视频流：[server/services/export.ts:113-128](/Users/yhg/i/redub/server/services/export.ts:113)。
- 字幕始终外挂 SRT，没有内嵌字幕、原声+配音可切换双音轨、语言标签或章节信息。
- 视频项目只能导出 MKV/MP4，不能单独导出配音 WAV：[server/services/export.ts:78-80](/Users/yhg/i/redub/server/services/export.ts:78)、[app/components/ProjectWorkspace.vue:1067-1070](/Users/yhg/i/redub/app/components/ProjectWorkspace.vue:1067)。

建议提供“领导播放版”“审片对比版”“后期音轨版”三个预设：

1. 领导播放版：兼容 MP4、配音主轨、可选内嵌中文字幕；
2. 审片对比版：原声/配音双轨，清晰标记语言；
3. 后期音轨版：配音 WAV、背景 WAV、原声 WAV、SRT 和时间码表。

### 25. 字幕修改后可能仍下载旧内容，且字幕和实际声音语义不一致

- 预览版本没有包含原文、译文和角色：[server/services/preview-tracks.ts:23-43](/Users/yhg/i/redub/server/services/preview-tracks.ts:23)。
- 已有 SRT 文件时不会重写：[server/services/export.ts:88-104](/Users/yhg/i/redub/server/services/export.ts:88)。
- 导出 SRT 对启用片段总是优先译文，但正式 mix 只在“启用且已有配音”时才换译文：[server/services/export.ts:96-100](/Users/yhg/i/redub/server/services/export.ts:96)、[server/services/pipeline.ts:352-358](/Users/yhg/i/redub/server/services/pipeline.ts:352)。

建议：把原文、译文、角色、时间和审核状态纳入版本键；每次按当前版本重写字幕；明确导出“中文配音字幕”“日语原文字幕”“双语字幕”三种选择。

### 26. 没有版本冻结、回滚和审核状态

数据库只有当前项目和片段状态，没有交付版本、审核记录或回滚快照：[server/db/schema.ts:4-20](/Users/yhg/i/redub/server/db/schema.ts:4)。

建议：每句增加“未校对/已校对/需返工/已通过”；每次交付创建只读版本，记录源文件、脚本、译文、配音、导出参数和哈希。返工生成新版本，不覆盖旧交付。

### 27. 缺少真实目标电影验收

文档已经说明真实火山 Audio、翻译接口和影视素材音色/背景听感尚未完成真实验收：[docs/IMPLEMENTATION.md:9-10](/Users/yhg/i/redub/docs/IMPLEMENTATION.md:9)。

建议先做同一部电影的 3–5 分钟代表性试片，必须包含：

- 多角色对话；
- 快速对白和重叠对白；
- 音乐/环境声较大的场景；
- 情绪变化、低声和喊叫；
- 专名、人名、敬语和口语。

代表性试片通过后再跑整片，不要把模拟 API 测试结果当成影视质量保证。

## P2：效率和工作体验

### 28. 视频与字幕文件不能一起导入

导入一次只接受一个文件；SRT/VTT 会创建文本项目，不能直接绑定到已有电影：[server/services/importer.ts:44-80](/Users/yhg/i/redub/server/services/importer.ts:44)、[app/components/ImportProject.vue:31-42](/Users/yhg/i/redub/app/components/ImportProject.vue:31)。

建议支持“视频 + 日文 SRT/VTT”一起导入，并自动按时间码建立片段，保留原字幕作为校对基准。

### 29. 试听工具不适合两小时电影逐句校对

当前全片波形压缩为 600 个峰值，界面再压成 96 根柱，无法放大到单句级别：[server/services/media.ts:79-82](/Users/yhg/i/redub/server/services/media.ts:79)、[server/services/preview-tracks.ts:303-309](/Users/yhg/i/redub/server/services/preview-tracks.ts:303)。

建议增加时间轴缩放、片段循环、前后各 0.5 秒上下文试听、原声/配音 A/B 切换、下一条待复核快捷键。

### 30. 没有明确的交付缺口清单

当前“跳过”可以让任务继续，但没有把缺失台词、失败片段、低置信度、未审核片段集中列出来。

建议增加交付前检查页，显示每个缺口的时间码、原文、译文、角色、当前音轨和处理动作；所有 P0 项通过后才能点击“锁定交付版本”。

### 31. 翻译和排队配置没有固化快照

翻译任务执行时读取当前全局翻译渠道，排队期间如果用户切换渠道或模型，任务可能使用新配置，结果无法复现。

建议任务入队时固化目标语言、翻译渠道、模型、提示词版本和术语表版本；已入队任务不受后续全局设置影响。

请求日志还会保存包含参考音频 Base64 的完整请求体：[server/services/providers.ts:127-139](/Users/yhg/i/redub/server/services/providers.ts:127)、[server/services/job-requests.ts:117-149](/Users/yhg/i/redub/server/services/job-requests.ts:117)。整部电影逐句生成会显著增大 SQLite，并留下原演员声音的长期副本。建议默认只保存大小、哈希和脱敏摘要，或提供保留期限与清理入口。

## 建议实施顺序

1. 先修交付阻断：最终导出与预览分离、全片缺口阻止导出、长配音不静默截断、非视频试听静音时钟、多音轨选择、AVI 能力统一。
2. 再修整片稳定性：分块/断点、片段并发、失败不阻塞、取消任务、磁盘预算与清理。
3. 再修配音质量：角色 profile、说话人分离、日语上下文识别、术语表、SSML 语言、响度和原声泄漏检测。
4. 最后补交付工程：版本冻结、审核状态、质量报告、双音轨/内嵌字幕、交付 ZIP 和 manifest。
5. 在真正修改整片前，用目标电影做 3–5 分钟代表性试片和 30 分钟压力试跑。


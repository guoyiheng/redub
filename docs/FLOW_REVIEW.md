 
 审查范围：从启动、导入、素材处理、台词编辑、翻译、配音、预览/合成、导出，到失败重试、任务恢复和导航状态。
 
 验证结果：现有自动检查全部通过（48 项单元测试、14 项 HTTP 集成测试、4 项 Python 识别规则测试，另有类型检查和构建通过）。本报告中的问题主要是现有测试没有覆盖的边界流程。另用隔离临时数据库实测复现了长配音截断、渠道保存清空成果、重叠片段、AVI 导出和旧字幕缓存问题。
 
 ## 按流程排序的问题
 
 ### 1. 导入阶段：AVI 可以导入，但后续导出必失败（P1）
 
 - 导入白名单包含 `.avi`：[server/services/importer.ts:19-34](/Users/yhg/i/redub/server/services/importer.ts:19)。
 - 导出源路径白名单不包含 `.avi`：[server/services/export.ts:30-35](/Users/yhg/i/redub/server/services/export.ts:30)。
 - 因此用户可以完成导入、识别和配音，最后导出时才得到“导出文件路径无效”。
 - 隔离实测：AVI 导入 HTTP 200，导出 MKV 任务失败。
 
 建议：要么在导入时拒绝 AVI，要么让导出路径校验和媒体支持列表一致，并补一条从 AVI 导入到视频导出的集成测试。
 
 ### 2. 素材处理阶段：先手动添加台词后，无法再补做人声分离（P1）
 
 - 工作区允许随时添加台词：[app/components/ProjectWorkspace.vue:610-618](/Users/yhg/i/redub/app/components/ProjectWorkspace.vue:610)。
 - 一旦已有台词，“识别素材中的台词”就被禁用：[app/components/BatchProcessing.vue:120-129](/Users/yhg/i/redub/app/components/BatchProcessing.vue:120)。
 - 后端也直接拒绝已有片段的 `prepare`：[shared/batch.ts:18-27](/Users/yhg/i/redub/shared/batch.ts:18)。
 - 这会把用户卡在“手动台词已经存在，但还没有人声/背景分离结果”的状态；后面使用原声参考或正式合成又要求分离结果。
 
 建议：把“准备素材（提取/分离）”和“自动分段/识别”拆成独立动作；已有台词时仍允许只补做缺失的素材处理阶段。
 
 ### 3. 预览阶段：音频/文本项目会把原声和预览音轨叠加播放（P1）
 
 - 音频项目的时间轴播放器源是原始 `sourcePath` 或 `audioPath`，文本项目的源是优化音轨：[app/components/ProjectWorkspace.vue:137-146](/Users/yhg/i/redub/app/components/ProjectWorkspace.vue:137)。
 - 点击播放时，时间轴播放器触发 `onClockPlay`，随后又播放勾选的预览音轨：[app/components/ProjectWorkspace.vue:254-269](/Users/yhg/i/redub/app/components/ProjectWorkspace.vue:254)、[app/components/ProjectWorkspace.vue:280-283](/Users/yhg/i/redub/app/components/ProjectWorkspace.vue:280)。
 - 视频时间轴元素有 `muted`，但非视频的隐藏 `audio` 没有 `muted`：[app/components/ProjectWorkspace.vue:935-947](/Users/yhg/i/redub/app/components/ProjectWorkspace.vue:935)。
 - UI 明确写着“此区域不播放原声”，实际却会播放。即使关闭所有下方音轨，时间轴播放器自身仍可能出声。
 
 建议：时间轴播放器只作为静音时钟，或让它在非视频项目完全不加载音频；试听声音只由勾选的音轨元素产生。
 
 ### 4. 预览与正式合成采用两套不同的重叠处理规则（P1/P2）
 
 - 保存片段时只检查是否超出素材时长，不检查与其他片段重叠：[server/api/[...path].ts:428-436](/Users/yhg/i/redub/server/api/[...path].ts:428)。
 - 正式 `mix` 遇到重叠会抛出“片段时间重叠或超出素材长度”：[server/services/pipeline.ts:334-341](/Users/yhg/i/redub/server/services/pipeline.ts:334)。
 - 预览优化音轨则用 `Math.max(cursor, line.start)` 把后一个片段压缩/推迟，可能改变时间或跳过片段：[server/services/preview-tracks.ts:266-274](/Users/yhg/i/redub/server/services/preview-tracks.ts:266)。
 - 隔离实测：同一组重叠片段可保存；正式合成失败，而导出优化音轨仍可完成，两个结果不一致。
 
 建议：保存时统一拒绝重叠；预览、mix、导出共用同一套时间轴校验和分段规则。
 
 ### 5. 配音阶段：配音过长时任务成功但尾字被截断（P1）
 
 - 对超过目标时长的音频最多只加速到 1.2 倍，然后使用 `atrim=0:duration` 强制截断：[server/services/media.ts:191-207](/Users/yhg/i/redub/server/services/media.ts:191)。
 - 隔离实测：将带有明显尾部音调的 4 秒配音放入 2 秒片段，任务显示完成，但输出尾部标记消失。
 - 这会让用户以为配音成功，实际台词后半句可能丢失。
 
 建议：超过可接受加速范围时让任务失败并提示“请扩大时间范围/缩短台词”，或明确采用可配置的完整语音裁剪策略；不要静默丢音。
 
 ### 6. 渠道设置阶段：保存渠道会无提示清空所有关联项目的配音成果（P1）
 
 - 任意渠道保存都会把所有引用该渠道的项目的 `generatedPath/generatedHash` 清空：[server/api/[...path].ts:87-114](/Users/yhg/i/redub/server/api/[...path].ts:87)。
 - 即使只是改名称、重复保存或更新 API Key，也会触发；影响范围包含使用微软 TTS 的片段，因为清理按项目渠道执行，而不是按片段实际合成方式执行。
 - 设置界面保存动作没有显示影响项目和成果会失效的提示：[app/components/StudioSettings.vue:128-141](/Users/yhg/i/redub/app/components/StudioSettings.vue:128)。
 - 隔离实测：已有配音时原样保存渠道，保存后 `generatedPath` 变为空。
 
 建议：只有会影响合成结果的字段变化时才失效对应片段；至少按合成方式和实际渠道区分；保存前给出影响范围并要求用户明确确认。
 
 ### 7. 失败恢复阶段：批量失败后修正渠道的路径被任务队列阻断（P1/P2）
 
 - 渠道修改只要全局存在 queued/running 任务就返回 409：[server/api/[...path].ts:91-96](/Users/yhg/i/redub/server/api/[...path].ts:91)。
 - 批量任务是依赖链，后续 queued 任务依赖失败任务：[server/services/queue.ts:60-74](/Users/yhg/i/redub/server/services/queue.ts:60)。
 - 用户想“修正渠道 → 重试失败任务”时，后续 queued 任务本身会阻止渠道修改；只能逐个跳过。
 - 跳过合成任务会把没有生成配音的片段设为 `enabled=false`：[server/api/[...path].ts:401-410](/Users/yhg/i/redub/server/api/[...path].ts:401)，会改变用户的替换选择。
 - “继续/重试”只解除项目暂停，失败依赖仍由队列依赖关系控制，操作含义不够直观。
 
 建议：允许暂停项目后修改渠道，并在重试时重建受影响的依赖链；跳过前明确说明会禁用哪些片段，不要用跳过来代替编辑配置。
 
 ### 8. 导出阶段：修改台词/翻译后仍可能下载旧 SRT（P1/P2）
 
 - 预览版本只包含时间、启用状态、生成文件等字段，不包含原文和译文：[server/services/preview-tracks.ts:23-43](/Users/yhg/i/redub/server/services/preview-tracks.ts:23)。
 - 导出使用同一个版本键；已有同名 SRT 时直接复用，不重写：[server/services/export.ts:88-104](/Users/yhg/i/redub/server/services/export.ts:88)。
 - 隔离实测：先导出“Before correction”，修改原文为“After correction”后再次导出，SRT 路径不变且内容仍是旧文本。
 - 同时，导出 SRT 对启用片段总是优先使用译文：[server/services/export.ts:96-100](/Users/yhg/i/redub/server/services/export.ts:96)，而正式 mix 只在“启用且已有生成配音”时才换成译文：[server/services/pipeline.ts:352-358](/Users/yhg/i/redub/server/services/pipeline.ts:352)。两条路径的字幕语义不一致。
 
 建议：把原文、译文、说话人和时间纳入版本键；每次导出按当前版本重写字幕；统一“未生成配音但启用片段”的字幕文本规则。
 
 ## 其他可见流程缺口（P2）
 
 - 路由参数只在页面挂载时读取；项目 A 切到 B 后通过浏览器后退/前进，URL 和当前工作区可能不同：[app/composables/useStudio.ts:40-44](/Users/yhg/i/redub/app/composables/useStudio.ts:40)、[app/pages/index.vue:47-50](/Users/yhg/i/redub/app/pages/index.vue:47)。
 - 添加台词只允许接在最后一句之后；最后一句占满素材尾部时，即使中间有空白，也不能补录中间缺失句：[app/components/ProjectWorkspace.vue:225-231](/Users/yhg/i/redub/app/components/ProjectWorkspace.vue:225)、[app/components/ProjectWorkspace.vue:610-618](/Users/yhg/i/redub/app/components/ProjectWorkspace.vue:610)。
 - 已有片段时无法重新执行识别；修改原始语言后没有清晰的“重新识别”入口，用户只能重新导入项目或手工改写。
 - 预览默认优化音轨在缺少背景音时直接使用配音：[server/services/preview-tracks.ts:232-239](/Users/yhg/i/redub/server/services/preview-tracks.ts:232)，但正式“合成成片”要求背景音存在：[shared/batch.ts:35-42](/Users/yhg/i/redub/shared/batch.ts:35)。用户会看到能试听/导出，却在正式合成入口被拒绝，且替换区间可能丢失环境声。
 
 ## 建议修复顺序
 
 1. 先修复会造成无声、丢字、旧字幕或无法完成导出的 P1：预览叠音、长配音截断、渠道保存清理、AVI 支持策略、SRT 版本缓存。
 2. 统一时间轴校验和预览/mix/export 行为，消除重叠片段的分支差异。
 3. 拆分“素材准备”和“自动识别”，让手工台词项目仍能补做分离。
 4. 重做失败任务恢复和渠道修改的交互，避免用户为修复一个失败任务而跳过其他台词。
 5. 最后补导航同步、插入中间台词和重新识别入口。
 
 

# Toonflow 短剧生产系统项目审计

日期：2026-11-06（Asia/Shanghai）  
阶段：阶段 0，只读审计  
依据：用户提供的《AI 短剧自动生产系统 —— 开发总则 v3》、本机源码快照、火山方舟官方文档

## 一、结论与审计边界

本机找到的 Toonflow 源码位于：

D:\Temp\claude\c88343a087018856\af42c4a0-6e61-4a5e-b5c2-5bcd9772db65\scratchpad\repos\Toonflow-app\Toonflow-app-master

Jellyfish 源码位于：

D:\Temp\claude\c88343a087018856\af42c4a0-6e61-4a5e-b5c2-5bcd9772db65\scratchpad\repos\Jellyfish\Jellyfish-main

它们都是源码压缩目录，没有 .git 元数据。无法确认分支、提交 SHA、用户 fork 或 upstream；当前 Codex 工作目录也不是 Toonflow 仓库。下面的核查适用于本机这份官方源码快照，不能代替用户 fork 的逐提交审计。阶段 0 输出文件放在当前工作区 outputs/，不是仓库 docs/，也没有 Git 提交。

本轮为获取可审计的 Git 基线，将官方仓库浅克隆到本任务 work/toonflow-upstream/。截至 2026-11-06，该 checkout 的分支为 master，HEAD 为 6086cdffceb704a632eca143dd16cd461a78cdac（2026-11-05，merge: 合并 Windows USTAR 安装归档修复），工作区干净，origin 指向 HBAI-Ltd/Toonflow-app。它不是用户 fork；本轮未在其中修改代码。

用户随后确认采用本报告的 D1–D9 建议并进入阶段 1，同时选择在自己的 fork checkout 上开发。具体确认包括：D2 同意仅允许仓库顶层 qa/ 放验证代码；D3 半自动；D4 Seedance 2.5；D5 暂不开 TOS；D6 本地 BGM；D7 真实价格阶段 3 前录入；D8 在用户另行批准内容、次数和金额前不调用真实 API；D9 暂不安装 sd25-pe。D1 采用虚拟人像/授权素材优先的方向。用户的 fork checkout 坐标尚未找到。

本阶段完成只读核查并整理了文档；未改产品代码、未安装依赖、未运行构建/测试、未调用真实模型，实际花费 0 元。继续阶段 1 前，应切换到目标 Git fork checkout，按其实际内容复核。

## 二、本机环境

| 项目 | 结果 |
|---|---|
| Git | PATH 中可用 |
| Bun | PATH 中未找到；无法运行当前 Toonflow |
| FFmpeg / FFprobe | PATH 中未找到；仓库有单独安装和下载管理代码，但本机应用内二进制未运行确认 |
| Node.js | PATH 中存在；版本未记录 |
| Toonflow/Jellyfish Git 元数据 | 两个目录均无 .git |
| 测试和 API | 未执行任何测试或 API 请求 |

## 三、Toonflow 源码审计

以下路径相对于 Toonflow-app-master 根目录。

| 能力 | 代码位置 | 已核实事实 / 实施影响 |
|---|---|---|
| 架构与版本 | package.json、apps/server/package.json | Bun + TypeScript workspace；server 使用 Express 5；packageManager 锁定 bun@1.4.3。当前环境缺 Bun，版本兼容需在阶段 1 实测。 |
| 路由生成 | apps/server/src/core.ts、apps/server/package.json | core.ts 扫描 routes/**/*.ts 生成 router；脚本为 bun run routes。新接口一接口一文件，不手改 router.ts。 |
| 主服务监听 | apps/server/src/index.ts | 默认端口 3000；app.listen(realPort, ...) 未显式传 host，未限制为 127.0.0.1。需在 fork 最小修改。 |
| 桌面 / 移动连接 | apps/desktop/src/connection.ts、apps/server/src/utils/mobileLink/index.ts | 桌面本地代理绑定 127.0.0.1。Mobile Link 默认 disabled，默认端口 43123；启用后独立监听器绑定 0.0.0.0。主服务改为回环地址时保留这个独立的显式局域网入口。 |
| Provider 接口 | packages/providers/types.d.ts | ProviderDefinition 支持图片/视频/音频、只读估价 getPrice、余额 getBalance、恢复 resumeTask；ProviderContext.saveTaskData 可保存供应商任务数据。 |
| 媒体任务 | apps/server/src/utils/media/tasks.ts | 任务按工作区哈希分目录存 JSON，使用原子写入；状态含 running/interrupted/succeeded/failed/cancelled；提供创建、状态、取消和恢复。它是单任务执行层，不是项目生产数据库或成本账本。 |
| 媒体任务恢复 | apps/server/src/utils/media/generation.ts | checkpoint 保存 providerData；恢复走原 Provider.resumeTask，不重新提交；结果文件有哈希 checkpoint；过期媒体 URL 可尝试重新读取原任务结果。新 Provider 应保存任务 ID 并查询原任务。 |
| 生成入口 | apps/server/src/routes/ai/media/generate.ts、apps/server/src/utils/media/tasks.ts、packages/nodeShared/src/useNodeGeneration.ts | 既有 API 和画布节点最终调用媒体生成能力。生产预算守卫必须覆盖画布、Agent 和 API 生成，而非只检查生产控制台。 |
| 当前 Provider | packages/providers/src/media/apiMart.ts、compshare.ts、metaso.ts；packages/providers/src/language/deepSeek.ts | 媒体目录没有火山方舟 Provider；DeepSeek 语言 Provider 存在。豆包快速模型和 DeepSeek 经方舟调用的具体配置需按最终 fork 再核对。 |
| 估价/余额 | apps/server/src/utils/media/billing.ts、priceReference.ts | 提供 Provider 价格与余额展示/刷新，不承担项目/剧集/片段账本、预算预留、实际结算和平台对账。 |
| ASR | packages/asr/src/index.ts | 浏览器 SpeechRecognition / webkitSpeechRecognition 能力，不是服务端豆包录音文件识别适配器；ASR 需作为生产侧服务实现。 |
| DOCX | apps/server/src/utils/documents.ts、apps/server/package.json | 使用 @firecrawl/anydoc 与 WASM 备用包，版本 0.2.4；支持按字节或扩展名识别格式，设置 OCR reject。AnyDoc 官方格式列表含 DOCX，但没有 Bun/依赖环境，未做 Windows 运行验证。 |
| Agent 工具注册 | apps/server/src/agent/tools/index.ts 的 createAgentTools；apps/server/src/utils/plugins/tools.ts | createAgentTools 汇总工具，插件工具经 listTools/loadTool/validateToolConfig 加载。新增生产工具可从该入口接入；任何付费操作仍必须调用生产服务。 |
| FFmpeg | packages/ffmpeg/src/index.ts、catalog.ts、apps/server/src/utils/ffmpeg/index.ts | 存在状态检测、下载安装源、安装/取消下载和 server 封装；合成优先复用 @toonflow/ffmpeg。 |
| Web 路由与页面 | apps/web/src/router/index.ts、apps/web/src/pages/ | 有 pages/ 目录，没有 production 页面。新增生产界面应按当前 Vue Router 与页面布局接入。 |
| 生产层 | packages/production/、apps/server/src/routes/production/、apps/web/src/pages/production/ | 当前快照都没有这些目录；SQLite 生产层、预算账本、调度器、生产 API 和控制台需新增。 |
| 编码规范 | AGENTS.md | 新文件/目录用小驼峰；server 路由一文件一接口；文件操作走 @toonflow/file；明确禁止任何测试模块、测试/自检文件、fixture、测试依赖及测试入口，不因目录名 qa/ 而豁免。目标 fork 的 AGENTS.md 必须重新读取；总则 D2 要由用户决定是否修订该规范。 |

### 可复用模块

1. apps/server/src/utils/media/tasks.ts 与 generation.ts：提交、状态、恢复和媒体落盘。
2. packages/providers/types.d.ts：供应商能力与任务恢复契约。
3. @toonflow/file：原子写入和统一文件操作。
4. apps/server/src/core.ts：自动生成路由。
5. @toonflow/ffmpeg：安装管理和媒体处理封装。
6. apps/server/src/agent/tools/index.ts：注册生产 Agent 工具。
7. Toonflow 技能与编剧知识：提取成结构化步骤提示片段，不让自由 Agent 决定是否花费或跳过状态机。

### 缺失能力

项目级/全局 SQLite、迁移、生产实体、小说证据索引、分集/剧本版本、候选确认、segment 生成模型、三态分离、预算守卫、成本账本、调度器、提示词版本与静态校验、字幕合成、质检和画布投影/采用能力均未在当前快照中发现。

## 四、Jellyfish 到 TypeScript 的移植映射

本机 Jellyfish 源码目录为压缩快照，无 .git。源码许可证为 Apache-2.0。移植应是 TypeScript 重写，不运行 Jellyfish Python 后端，也不引入其 Python 依赖。正式实现需在文件头和 docs/thirdPartyNotices.md 注明来源及许可证。

| Jellyfish 源文件/逻辑 | 建议目标 | 保留与调整 |
|---|---|---|
| backend/app/models/studio_projects.py | packages/production/src/db/schema.ts：项目、剧集 | 沿用项目/章节语义，扩展预算、视频模型锁定、运行模式等。 |
| backend/app/models/studio_shots.py | 项目库 schema/repository：Shot、ShotDetail、FrameImage、DialogLine、CharacterLink、提取候选 | Jellyfish shot 作为本系统 segment 中的描述单位；segment 才是视频生成单位。 |
| backend/app/models/studio_assets.py、studio_asset_images.py | asset、assetVariant、assetImage、voiceProfile | 沿用角色/场景/道具/服装、多视图；增加锁定、原始产物哈希、信任期限和用户确认。 |
| backend/app/models/task.py、task_links.py | generationTask、generationTaskLink | 加 Toonflow task ID、供应商 task ID、幂等键、成本预留/结算、恢复信息。 |
| backend/app/models/studio_prompts_files_timeline.py | promptTemplate、promptVersion、renderJob | 借鉴模板和文件结构；总则已指出 Jellyfish timeline API 是空壳，不将其视为合成实现。 |
| backend/app/models/types.py | TypeScript 类型与 Zod schema | 重写枚举；内容确认状态、任务状态、就绪度分别存储/计算。 |
| backend/app/schemas/skills/script_processing.py、chains/agents/script_processing_agents.py | packages/production/src/pipeline、src/steps | 保留按行拆镜、逐镜提取角色/道具/场景/对白/动作、原文 evidence 和置信度；用 Zod 校验。 |
| backend/app/services/studio/entity_existence.py、实体合并 Agent | packages/production/src/pipeline/entityMerger.ts | 别名归并、稳定 ID、首次证据、变体和冲突候选；不能覆盖已锁定资产。 |
| backend/app/services/studio/shot_preparation_state.py、shot_video_readiness.py | packages/production/src/readiness.ts | 确定性无副作用函数，返回缺失参考图、过期信任、提示词失败、预算不足等原因。 |
| backend/app/chains/agents/shot_frame_prompt_agents.py | packages/production/src/prompt/framePrompt.ts | 移植首帧/尾帧/关键帧和动作拍点规则。 |
| backend/app/services/studio/shot_video_prompt_pack.py | packages/production/src/prompt/contextPack.ts、promptCompiler.ts | 沿用前后镜承接、构图锚点、朝向和动作上下文；输出改为 Seedance 指南适配格式，不照搬字段堆叠的 Prompt。 |

## 五、火山方舟官方文档核查

模型 ID、计价、限额、素材规则可能变化；实现前需按目标账号和最新文档再次核验。

### Seedance 视频

- 创建为异步接口：POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks，查询为同资源加任务 ID。
- Seedance 2.5 的 omni_reference_task_type 支持 auto/reference/edit/extend。auto 可能异步返回 InvalidParameter.TaskTypeConstraint；指定类型不匹配仍可能 InvalidParameter.TaskTypeMismatch。edit 需 reference_video 4–30 秒、ratio=adaptive、duration=-1；extend 需 reference_video 和 ratio=adaptive。
- return_last_frame=true 可在查询结果返回尾帧图像，供下一片段承接。
- Seedance 2.5 输出支持 480p/720p/1080p；其 1080p 为 10bit H.265/HEVC。成片要求 H.264/AAC 时需经 FFmpeg 转码。
- Draft 仅 Seedance 2.5 支持；样片与正式视频两步分别计费。2026-10-28 后创建的 Draft ID 有效 14 天。样片任务需单独记录账本。
- 视频 URL 有效期为 24 小时；Seedance 2.5 下载次数有限制，任务成功要立即下载。URL 有效期与任务可查询期不是同一字段。
- usage.completion_tokens 可用于视频生成量核对；价格依模型和规格变化，Seedance 2.0 系列另有最低 token 用量规则。不硬编码单价。
- 当前官方模型资料显示个人账号普通请求常见额度为 180 RPM、并发 3；企业资料为 600 RPM、并发 10。特定模型、分辨率及账号额度可能不同，以控制台为准。默认并发 2 只能作为配置起点。

### 人脸与素材传输

- 官方文档说明 Seedance 2.0/2.5 不接受直接上传含真人人脸的参考图/视频。可用方案包括平台可信虚拟人像、真人授权录入、同账号生成的可信原始产物。
- 30 天规则与可用模型/素材类型随具体能力和文档版本而异。需记录原始字节哈希、生成模型、时间、账号上下文和信任期限；不能把编辑/压缩后文件默认当作原始可信产物。动漫/3D 是否能避开审核，官方没有保证，需在用户批准的样片阶段验证。
- 视频接口可用 URL/Base64，部分可信资产支持素材 ID；教程建议使用平台可访问的 URL。官方资料未要求所有请求必须开 TOS。D5 建议先选传输方式、确认隐私与可访问性，再决定是否开通。
- 本次没有用户账号控制台信息，无法确认用户账号的素材库、TOS、额度或授权状态。

### Seedream、TTS、ASR

- Seedream 4.0–5.0 指南建议清楚描述主体、动作、环境，按用途补充风格、色彩、光影和构图。Seedream 5.0 型号之间的图片数量和规格限制不同。
- 豆包语音合成 2.0 有官方 HTTP 合成 API。选型需确定短文本/流式/长文本路径、speaker ID、音频格式和单价；生产侧应逐句缓存文本、音色、参数与文件哈希。
- 豆包录音文件识别 2.0 为异步提交/查询：提交可访问的音频 URL，并使用 X-Api-Key、X-Api-Resource-Id=volc.seedasr.auc、任务 ID；查询可返回 text 和按参数提供的 utterances。浏览器 ASR 不是此服务的实现。
- AnyDoc 官方格式列表包含 DOCX；本机 server 依赖版本是 0.2.4，但未安装依赖进行 Windows/Bun 端到端验证。

### 官方参考链接

- [Seedance 创建任务 API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)
- [Seedance 查询任务 API](https://docs.volcengine.com/docs/ark/get-video-generation-task-api?lang=zh)
- [Seedance 任务列表 API](https://docs.volcengine.com/docs/ark/list-video-generation-tasks-api?lang=zh)
- [Seedance 2.0 教程](https://docs.volcengine.com/docs/ark/seedance-2-0?lang=zh)
- [Seedance 视频生成教程](https://docs.volcengine.com/docs/ark/video-generation-tutorial?lang=zh)
- [Seedance 2.5 页面](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh)
- [Seedance 定价说明](https://docs.volcengine.com/docs/ark/model-pricing?lang=zh)
- [Seedream 提示词指南](https://docs.volcengine.com/docs/ark/seedream-4-0-5-0-prompt-guide?lang=zh)
- [图片生成 API](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh)
- [Seedream 与 Seedance 实践](https://docs.volcengine.com/docs/ark/seedream-4-0-seedance?lang=zh)
- [方舟文档 Skill 说明](https://docs.volcengine.com/docs/ark/ark-document-skills?lang=zh)
- [豆包 TTS HTTP 接口](https://docs.volcengine.com/docs/doubao-voice/audio-generation-http?lang=zh)
- [录音文件识别任务提交](https://docs.volcengine.com/docs/doubao-voice/task-submission-http-1?lang=zh)
- [录音文件识别结果查询](https://docs.volcengine.com/docs/doubao-voice/result-query-http-1?lang=zh)

方舟官方页面说明 sd25-pe 用于整理/优化 Seedance 2.5 提示词，不会自行提交生成任务。其完整文件未能从文档页读取；对常见 SKILL.md 地址的只读请求返回 404。没有安装或执行 Skill。D9 建议用户决定是否之后安装并只读核对规则。完整错误码表尚未逐条整理；实现时应保留未知错误码/原文，首次真实调用前按官方完整错误表分类。没有方舟 API 请求。

## 六、新增/修改文件清单（后续实施建议）

以下是目标路径建议，不代表已创建；在 fork 上按 AGENTS.md 和实际路由结构复核。

新增：
- packages/production/：@toonflow/production；内部 db、pipeline、steps、prompt、budget、tasks、scheduler、render、review、canvasProjection。
- packages/providers/src/media/volcengine.ts：Seedream/Seedance/TTS Provider。
- packages/production/src/asr/volcengineAsr.ts：豆包录音文件识别适配器。
- apps/server/src/routes/production/：单接口路由。
- apps/server/src/utils/production/：宿主接入胶水。
- apps/web/src/pages/production/ 与统一生产 API 客户端。
- scripts/windows/：环境、启动、停止、日志、备份。
- docs/thirdPartyNotices.md：Jellyfish Apache-2.0 归属与声明。

修改：
| 文件 | 原因 |
|---|---|
| apps/server/src/index.ts | 主服务默认明确绑定 127.0.0.1；保留 Mobile Link 独立开关与监听 |
| apps/server/src/utils/media/tasks.ts 或统一媒体入口 | 生产项目手动媒体生成加预算守卫，不改变执行层恢复语义 |
| apps/server/src/routes/ai/media/generate.ts | 生产项目请求经过幂等、预算和账本服务 |
| apps/server/src/agent/tools/index.ts | 注册生产工具，付费操作统一走生产服务 |
| apps/web/src/router/index.ts | 添加生产页面路由与入口 |
| apps/server/src/router.ts | 仅由路由生成器更新，禁止手改 |

实际原文件修改（2026-11-07）：`apps/server/src/utils/media/generation.ts` 在统一供应商执行前检查生产工作区，`apps/server/src/utils/media/tasks.ts` 在新持久任务落盘前执行同一检查。新增判定逻辑独立放在 `apps/server/src/utils/production/generationGate.ts`；现阶段遇到生产故事一律拒绝旧生成路径，后续预算事务接入后需将此处改为经过授权的提交。

生产绑定增补（2026-11-07）：上述两个入口现在将 taskId、媒体类型及请求交给门禁；只有内部生产调用上下文与 SQLite 归属/请求/有效预留匹配才放行首发，普通 HTTP 请求仍无法绕过。`tasks.ts` 新增服务器内部只读 `inspect`，沿用原记录解析、权限和锁，不调用上游、不自动恢复，也不加入公开状态响应。桥接逻辑位于 `utils/production/videoTasks.ts`，首发内部方法尚待上游完整就绪及报价授权接入；当前生产 HTTP 只开放已绑定视频恢复。未修改原供应商恢复、下载或多租户计费语义。

实际原文件修改（2026-11-07）：`apps/server/src/app.ts` 在初始化配置后、开启请求服务前调用全局生产任务恢复。`apps/server/src/utils/production/index.ts` 增加恢复入口，并把配置模块加载延后到实际工作区操作，以便隔离验证。

## 七、D1–D9 决策建议

以下建议已由用户确认采用；D8 的人民币限额仍须在真实调用前单独给出。

| 编号 | 建议 | 用户需确认 |
|---|---|---|
| D1 真人角色长期一致性 | 优先评估虚拟人像库/已授权素材；将 30 天原始产物续接纳入到期管理；动漫/3D 审核表现待样片验证。 | ①虚拟人像 ②授权真人 ③30 天内尾帧续接 ④动漫/3D 优先，可多选。 |
| D2 测试规范 | 建议允许只在仓库顶层 qa/ 放 Mock 与验证，不进入构建/安装包。未获同意前不改 AGENTS.md，不加测试代码。 | 同意 / 不同意。 |
| D3 默认运行模式 | 半自动。 | 自动 / 半自动 / 逐步。 |
| D4 视频模型 | 以 Seedance 2.5 为主，阶段 3.5 后按数据决定；单项目锁定模型。 | 2.5 / 2.0 / 2.0 mini。 |
| D5 TOS | 暂不要求开通；依据最终 URL/Base64/素材 ID 路径和隐私/访问需求再决定。 | 确认是否已有 TOS；需要时再开通。 |
| D6 BGM | 首期本地授权素材库。 | 本地素材库 / 后续接音乐生成。 |
| D7 价格/预算 | 价格由用户录入，记录计量单位、币种、来源、生效日；阶段 3 前配置模型价格和限额。 | 具体单价、单集/项目/每日/模型预算。 |
| D8 真实调用上限 | 现阶段默认 0；阶段 3 和 3.5 分别设置绝对金额上限。 | 每阶段人民币上限，并确认调用素材、提示词和次数。 |
| D9 sd25-pe | 首版规则依据公开指南；暂不安装。用户同意后可安装并仅阅读。 | 同意 / 不同意之后安装且只读检查。 |

真实 API 花费需要逐阶段明确批准素材/提示词、调用次数和人民币上限。用户已明确保持当前上限为 0，直至另行设定。

## 八、风险与未验证项

1. 用户 fork 尚未定位为 Git checkout；当前只有可审计的官方上游浅克隆，无法在目标分支改动或提交。
2. 本地源码压缩包没有提交 SHA，不能证明它等于用户 fork 或当前上游。
3. 环境缺 Bun/FFmpeg PATH；bun:sqlite 与 Electrobun Windows 打包未验证。
4. AGENTS.md 禁止测试，与可靠零费用验证需求冲突；由 D2 决定。
5. 方舟模型、价格、限流、任务有效期和 API 字段可能变化；价格/用量需账本快照并对账。
6. 结果 URL 有效期短；应成功后立即下载，任务恢复不能保证远端链接永久有效。
7. 真人素材审核与原始产物可信规则依模型、账号和时间变化；不可默认压缩后仍可信。
8. 画布/Agent/API 生成都要覆盖预算守卫，避免绕过。
9. Seedance 2.5 1080p 输出 HEVC 10bit，目标 MP4 的 H.264/AAC 转码需验证。
10. sd25-pe 完整 Skill 未读，D9 未决；用户账号实际素材库、TOS 和限额未核对。

## 九、实际完成记录

已完成：只读检查两份源码目录和 Git 上游基线、整理可复用/缺失模块、记录 Jellyfish 移植映射、核对方舟核心任务/素材/计费/TTS/ASR 文档、用户确认 D1–D9 建议、生成审计和路线图。

未完成：用户 fork 的 Git/分支核验；读取 sd25-pe 正文；安装 Bun/FFmpeg；构建、启动或测试；真实 API 调用。

验证：静态读取成功；git rev-parse 两个快照都报告不是 Git 仓库；bun、ffmpeg、ffprobe 不在 PATH。无代码改动、无 API 请求、花费 0 元。

## 十、目标 fork 与基线修订（2026-11-06）

视频采用与合成接入（2026-11-08）：在生产层新增不可覆盖的片段采用记录，复用原生产/宿主媒体绑定与文件读取校验，不另建供应商请求或下载服务。原 store.ts 的合成清单新增授权整片段归属验证，ffmpegSynthesis.ts 支持无字幕的显式审片版，synthesisWorker.ts 可恢复失败的本地免费合成任务；既有字幕、音轨与配乐合成保留并回归。浅色制作台直接提供预览、采用、时间线、合成与下载。路由由生成器维护，未修改多租户语义、未删除历史媒体或数据库记录；新安装包与真实短剧质量尚未验收。

人物来源投产原文件修改（2026-11-07）：`utils/media/generation.ts` 在本地生产首次提交时，通过已有供应商 fetch 注入点增加一次 POST 限制和片段预检复核；普通画布调用无生产上下文时仍使用原 fetch，恢复路径也不走首发检查。`production/generationGate.ts` 使用现有预算绑定及生产快照，最终发送前核验来源期限、当前方案、价格和已批准配置。`getAssetReferences` 增加只读来源期限说明，图库和片段页复用同一规则。未改多租户网关语义、未删除数据或重写旧候选；历史方案中的 P14 提示仅在界面显示为当前操作指引，避免因改文案破坏已有输入哈希。

资产生成原文件修改（2026-11-07）：内置 volcengine 供应商扩展 Seedream 单图协议，继续由宿主 tasks.ts 执行、持久化和落盘；生产 videoTasks.ts 原入口委托统一 image/video 桥接。generation.ts 在首次生产提交读取同一配置快照，连同实际供应商版本校验凭据指纹，恢复路径不重新 POST。生产图库复用原模型设置、价格中心与原图绑定；新增来源表保存生成记录，不更改既有 source_kind 约束、不删除历史数据。路由由生成器更新，多租户语义未改。此项不表示平台人脸信任、生成质量或新安装包已验收。

媒体投产原文件修改（2026-11-07）：`utils/media/generation.ts` 仅在服务端生产提交上下文内对最终参考字节作内容寻址核验，并对实际载入供应商源码版本作授权比对；原生恢复仍使用已有回执，不重新读取参考素材或 POST。生产工作台、共用设置包装与客户端接入具体片段首发，源码模型设置直接整合在同一页面。项目备份增加项目范围内的生产媒体绑定及宿主全局任务回执快照。新增 HTTP 路由通过生成器维护，未修改多租户语义。真实 API 与新安装包尚未验证。

媒体整合原文件修改（2026-11-07）：`packages/providers/index.ts` 与包 exports 注册内置 `volcengine.ts`，`apps/server/src/app.ts` 加入随构建安装清单。`utils/media/generation.ts` 向方舟传递已验证的 `referenceOrder`，为视频模型返回已有 `imageRatios` 声明；`utils/media/schemas.ts` 仅对视频请求增加 `adaptive`。视频生成节点读取模型比例，未声明时沿用旧选项，比例图标支持 adaptive。执行语义继续复用原 `tasks.ts` 与下载恢复逻辑，没有另建执行队列或取消生产预算保护。移除未进入产品调用的生产包旧方舟适配器及其单元验证，替换为原生供应商及实际宿主 HTTP/进程恢复验证。其他供应商保留，未修改多租户路由及计费逻辑。

实际整合更新（2026-11-07）：生产首页和工作台直接复用 `apps/web/src/components/settings/index.vue` 的模型设置与权限过滤，生产页不再依赖跳转旧首页配置模型。生产接口复用 `utils/workspace/files.ts` 的路径边界与写锁、`useWorkspaceFiles` 的前端读写入口；新增原图绑定仅对生产资料建表，未修改旧画布资产。读取原图使用哈希验证而不持有排他写锁，支持多个缩略图并发读取；新保存仍使用排他写锁及只新建写入。原路由注册通过生成器更新。详细实现与验证见路线图“资产原图与版本接入”。

用户创建的 fork 为 luck158166-cmyk/Toonflow-app，本地基线与 origin/master 均为 6086cdffceb704a632eca143dd16cd461a78cdac。上面的历史记录保留当时事实；本机已通过工作区 Bun 1.4.3 运行 SQLite，FFmpeg 已在隔离工具目录验证，用户选择暂不安装 sd25-pe。独立服务的监听修改、Vite 开发监听修改、顶层 qa 例外和 Windows 脚本仍在阶段 1 中，验收未完成。真实模型费用 0 元。

实际原文件修改（2026-11-07）：`apps/server/src/utils/ai/index.ts` 为生产编剧增加可选执行策略，显式传入输出 token 上限、关闭 SDK 重试、按调用限制一次网络请求并拒绝自动重定向、启用原始用量采集。未传入该策略的原聊天调用保持原参数与重试行为。生产适配位于 `apps/server/src/utils/production/textProvider.ts`，沿用宿主的协议 SDK 和直连访问检查；多租户路由拒绝走此本地生产入口。`production/index.ts` 按需加载该适配，避免仅恢复生产任务时初始化模型配置。

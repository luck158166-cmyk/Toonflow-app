# MoneyPrinterTurbo 参考价值评估

核查日期：2026-11-07。上游仓库：[harry0703/MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo)，本地只读快照提交 `8b0206be2c7977e3bc3cf25ff99a2adc3c9c65f9`，许可证 MIT。此文件只记录评估；尚未复制其代码、运行其服务或将其加入产品依赖。

## 定位

MoneyPrinterTurbo 的主流程是“主题/关键词 → 短视频脚本 → 配音 → 字幕 → 素材 → 剪辑/配乐 → 成片”（`app/services/task.py::_run_pipeline`）。视频素材可来自本地、图库或视频模型，合成主要在 `app/services/video.py`。它擅长解说、知识类和素材混剪短视频。当前项目的目标是连续剧情短剧，要求人物、场景、动作、对白及镜头承接跨片段一致，所以它不能取代 Toonflow 执行层或 Jellyfish 生产模型。

## 值得吸收的实现

| 上游源码 | 参考点 | 本项目落点 |
|---|---|---|
| `app/services/video_project.py` 的 `stage_graph`、`plan`、`render` | 分阶段指纹、依赖校验、SHA-256 验证、版本化产物和局部重渲染；只改 BGM 时不重做单场景 | 在 `packages/production` 的合成任务上建立 TypeScript 渲染依赖图，与现有 SQLite 任务、费用账本和 `FfmpegSynthesis` 连接；只重做受影响的字幕、音轨、片段或最终导出 |
| `app/services/task.py::generate_subtitle`、`app/services/subtitle.py`、`app/utils/subtitle_writer.py` | TTS 时间戳与 ASR 两种字幕时轴；先验证字幕 cue，再原子发布 | 以豆包语音与识别为音频来源，逐对白/旁白生成、校准、保存 SRT/ASS，错误时不覆盖已成功字幕 |
| `app/services/video.py::generate_video`、`app/services/utils/subtitle_shaping.py` | 字幕字体回退、可见像素定位、换行与样式；配乐循环、音量和淡出；Windows 资源释放 | 吸收算法和边界检查，仍用 Toonflow 现有 FFmpeg 包构建渲染，不引入 Python/MoviePy 运行时 |
| `app/services/video.py` 编码器回退与合成前预检 | 硬件编码失败后回退 H.264 软件编码、素材尺寸和字幕颜色检查 | 增加可选编码器回退及输出探测，保持 9:16、1080×1920、H.264/AAC 验收标准 |

这些参考主要补强后期与局部重做，不能代替故事分析、分集、角色/场景资产、镜头就绪、方舟多模态参考或费用治理。`video_project.py` 的场景模型仅有 footage、narration、audio、duration、BGM；需要扩展为多角色对白、原生片段音、旁白、音效、字幕与场次变更。

## 不直接并入的部分

- 不运行其 Python WebUI、API、MoviePy 管线；本项目保持 Toonflow 的 Bun/TypeScript、Electrobun 和本地 SQLite 架构。
- 不把图库关键词素材匹配作为剧情短剧主路径。图库可在用户提供并确认素材使用权时作为转场或背景补充，但无法稳定复现同一角色和场景。
- 不直接接入其 `app/services/volcengine_seedance.py`：当前提交的请求 `content` 只有文本，默认模型为 Seedance 1.0，不能覆盖总则要求的 Seedance 2.5 多模态参考与片段承接。火山适配仍按官方契约和项目预算事务实现。
- 不接入其 `upload_post.py` 第三方自动分发。项目的验收目标是可发布 MP4；外发素材和平台账号需要独立设计与授权。
- 不照搬它的任务状态作为付费幂等或费用账本。远端 ID 保留和轮询恢复值得参考，但生产支出继续由本项目的预留、对账、结算及重启守卫负责。

## 优先顺序与验收

先打通 Toonflow + Jellyfish 的一集剧情生产主链；在合成阶段借鉴分阶段指纹和局部重渲染，再接字幕、配乐、编码回退和质量预检。对照场景应包含：只改字幕不重新生成视频、只改 BGM 不重新生成片段、合成中断后复用已验证产物、损坏缓存被拒绝、完整成片音画与字幕同步。任何参考实现都不能绕过本项目的预算、幂等和真实模型调用授权。

若未来直接复制或改写具有可识别性的上游代码，须保留 MoneyPrinterTurbo 的 MIT 版权与许可声明，并在第三方声明中记录来源文件和提交。当前评估没有引入其代码。

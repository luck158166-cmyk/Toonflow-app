# 剧本到视频提示词：开源项目核查

核查日期：2026-11-07。目的：降低无人值守生产中的无效视频调用，防止“写出提示词但反复抽卡”的半成品。以下是只读源码评估，未复制代码、安装 Skill、接入额外模型或产生真实 API 费用。

## 核查范围与结论

| 项目与源码快照 | 许可证、证据 | 决策 |
|---|---|---|
| [zenstory-ai/drama-skills](https://github.com/zenstory-ai/drama-skills)，`862ae46` | MIT。`skills/short-drama-video-prompts/references/seedance-2.5.md` 区分 2.5 的镜头时间轴、参考/编辑/延长任务；`skills/short-drama/scripts/creator_markdown_check.py` 校验跨文档引用、连续性锁、素材编号、时长；`.github/workflows/ci.yml` 有单元与 Windows 工作流。仓库有固定长篇回归和跨题材剧本质量评估。 | **优先吸收方法与可机器检查的规则**：资产连续性锁、冻结关键帧、参考素材职责、提示词版本与模型方言。它本身是 Agent Skill 和文件工作流，不是可直接部署的无人值守引擎；仓库展示的 Seedance 小样本不能证明本项目的正式成片通过率。 |
| [eternityspring/shuohao-skills](https://github.com/eternityspring/shuohao-skills)，`5612d2a` | Apache-2.0。`skills/novel-storyboard/scripts/novel-storyboard.mjs` 以代码拼装 Seedance 投产包，检查分集时长、台词、场景、角色、图位和提示词字段；本机运行 `node skills/novel-storyboard/scripts/selftest.mjs`，336 项自测通过。 | **吸收确定性质量门与导出结构**。该仓库 `references/seedance-prompt.md` 明确依据 Seedance 2.0，禁止秒级时间轴；火山官方 2.5 指南支持整数秒时间轴，因此不能照搬其 Seedance 提示词规范到 2.5。 |
| [reaink/script2video](https://github.com/reaink/script2video)，`63ea5dd` | MIT。`lib/prompts/storyboard.ts` 有详细导演提示词和 JSON 结构；README 明言 `Auto-continue` 只部分实现。 | **不作为无人值守核心**。它主要是一次模型写分镜、一次模型复审，再进入逐镜生成；缺本项目要求的资产锁、付费预算事务、生产级静态预检与故障恢复证据。 |

官方依据：[火山方舟 Seedance 2.5 提示词指南](https://docs.volcengine.com/docs/ark/seedance-2-5-prompt-guide?lang=en)。模型支持多模态参考及镜头/时间轴写法，但提示词本身不能保证人物、动作、台词和音画都正确，生成后仍需实测。

## 接入方式

1. 保持 Toonflow 为唯一 Windows 宿主和媒体执行层，Jellyfish 移植的结构化镜头、资产与证据为唯一生产数据源。
2. 在 TypeScript 新增“镜头计划 → 可生成性判断 → 锁定关键帧与参考图 → 目标模型提示词编译 → 静态检查 → 预览/报价 → 预算预留 → 提交”的确定性链路。借鉴上述项目的规则，按 Seedance 2.5 官方方言重写，不能在运行时依赖另一个 Agent 随意改写已确认剧情。
3. 静态检查必须在任何付费请求前阻止：人物/场景与镜头不符、连续性锁丢失、参考图缺失或编号漂移、前后状态冲突、台词被改写、时长装不下动作/对白、生成任务类型与素材不匹配、模型参数非法、预算不足。高风险精细动作应拆镜或转人工，不自动多次抽卡。
4. 通过静态检查只能叫“可提交”，不能叫“生产级”。先用固定剧本做零媒体费用的提示词对照，再在用户批准的内容、次数与金额范围内跑有限的 480p 样片，盲评一次通过率、每个可用片段的实际成本、角色一致性和失败原因。只有结果明显优于现有模板，才进入完整 1080p 生产链。
5. 自动模式遇到已提交但状态不明、连续两次不合格、预算边界或人工无法判定的视觉/剧情问题必须停在对账或审核，不盲目重提付费任务。成功片段只引用已有产物；局部重做只针对失败片段。

## 证据边界

- `shuohao-skills` 的 336 项是该项目确定性逻辑自测，不代表视频模型的通过率。
- `drama-skills` 的测试与样片由上游提供；本机未运行其 Python 检查器（当前 PATH 只有 Windows Store Python 占位入口），也没有用本项目真实素材复现其质量结论。
- 当前 Toonflow 开发分支只有提示词策略守卫及生产数据底座；上述镜头计划、参考图绑定和 Seedance 2.5 编译器尚未完成。不能因此宣称无人值守或生产级成片已实现。

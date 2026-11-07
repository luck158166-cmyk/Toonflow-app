import { createHash, randomUUID } from "node:crypto";
import type { ProductionCatalog } from "./catalog";
import { checkSourceEvidence } from "./novelAdaptation";

export type EpisodeReviewDecision = "confirmed" | "changes_requested";

function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

/** Review only production content. Runtime tasks and generated files remain untouched. */
export function getEpisodeReview(catalog: ProductionCatalog, projectId: string, episodeId: string) {
  const story = catalog.getStory(projectId);
  if (!story || catalog.getEpisode(episodeId)?.projectId !== projectId) throw new Error("当前故事没有这个分集");
  const project = catalog.getProjectProduction(projectId);
  const episode = project.episodes.find(item => item.id === episodeId)!;
  const shots = project.shots.filter(item => item.episodeId === episodeId);
  const shotIds = new Set(shots.map(item => item.id));
  const props = project.shotProps.filter(item => shotIds.has(item.shotId));
  const characters = catalog.db.query(`SELECT l.shot_id AS shotId, l.character_id AS characterId,
    l.costume_id AS costumeId FROM shot_character_link l JOIN production_shot s ON s.id = l.shot_id
    WHERE s.episode_id = ? ORDER BY s.sequence, l.character_id`).all(episodeId) as Array<{
      shotId: string; characterId: string; costumeId: string | null }>;
  const dialogue = catalog.db.query(`SELECT d.id, d.shot_id AS shotId, d.sequence, d.kind,
    d.speaker_id AS speakerId, d.listener_id AS listenerId, d.text, d.emotion, d.voice_profile AS voiceProfile
    FROM shot_dialogue d JOIN production_shot s ON s.id = d.shot_id
    WHERE s.episode_id = ? ORDER BY s.sequence, d.sequence`).all(episodeId) as Array<{
      id: string; shotId: string; sequence: number; kind: string; speakerId: string | null;
      listenerId: string | null; text: string; emotion: string; voiceProfile: string }>;
  const assetIds = new Set([...characters.flatMap(item => [item.characterId, item.costumeId]),
    ...props.flatMap(item => [item.propId, item.holderBeforeId, item.holderAfterId]),
    ...dialogue.flatMap(item => [item.speakerId, item.listenerId])].filter((id): id is string => !!id));
  const sceneIds = new Set(shots.map(item => item.sceneId));
  const assets = project.assets.filter(item => assetIds.has(item.id));
  const scenes = project.scenes.filter(item => sceneIds.has(item.id));
  const issues = episode.scriptReport.checks.map(item => item.message);
  if (!episode.outline.length) issues.push("尚无分集提纲");
  if (!shots.length) issues.push("尚无分镜，不能确认本集制作内容");
  if (assets.length !== assetIds.size) issues.push("镜头中存在不属于本故事的资产引用");
  if (shots.some(item => !item.sceneId || !scenes.some(scene => scene.id === item.sceneId))) issues.push("镜头缺少本故事的场景");
  if (shots.some((item, index) => item.sequence !== index + 1)) issues.push("分镜序号必须从 1 连续排列");
  if (shots.some(item => !item.scriptExcerpt.trim() || !Number.isSafeInteger(item.durationMs) || item.durationMs <= 0)) issues.push("分镜缺少内容或有效时长");
  for (const asset of assets) if (!asset.stableDescription.trim()) issues.push(`${asset.name}缺少稳定外观描述`);
  if (project.chapterIndex) {
    issues.push(...project.chapterIndex.issues);
    const evidenceLists: Array<[string, unknown[]]> = [
      ...episode.script.map((scene, index) => [`第 ${index + 1} 场`, scene && typeof scene === "object"
        && "evidence" in scene && Array.isArray(scene.evidence) ? scene.evidence : []] as [string, unknown[]]),
      ...assets.map(item => [item.name, item.evidence] as [string, unknown[]]),
      ...scenes.map(item => [item.name, item.evidence] as [string, unknown[]]),
      ...shots.map(item => [`镜头 ${item.sequence}`, item.evidence] as [string, unknown[]]),
      ...props.map(item => [item.propName, item.evidence] as [string, unknown[]]),
    ];
    for (const [label, evidence] of evidenceLists) {
      if (!evidence.length) issues.push(`${label}缺少原文证据`);
      for (const reference of evidence) {
        const result = checkSourceEvidence(story.sourceText, project.chapterIndex, reference);
        if (!result.valid) issues.push(`${label}：${result.reason}`);
      }
    }
  }
  // Include all reviewed facts, but exclude background task progress from optimistic concurrency.
  const snapshot = { sourceHash: createHash("sha256").update(story.sourceText).digest("hex"), episode,
    shots: shots.map(({ runtimeState, videoReadiness, ...shot }) => shot), assets, scenes, props, characters, dialogue };
  const history = catalog.db.query(`SELECT id, decision, note, reviewed_by AS reviewedBy, created_at AS createdAt
    FROM episode_review WHERE episode_id = ? ORDER BY rowid DESC`).all(episodeId) as Array<{
      id: string; decision: EpisodeReviewDecision; note: string; reviewedBy: string; createdAt: number }>;
  const hasSuccessor = project.episodes.some(item => item.episodeNumber > episode.episodeNumber);
  return { snapshotHash: hash(snapshot), snapshot, sourceText: story.sourceText,
    issues: [...new Set(issues)], history, hasSuccessor };
}

export function reviewEpisode(catalog: ProductionCatalog, input: { projectId: string; episodeId: string;
  snapshotHash: string; decision: EpisodeReviewDecision; note: string }) {
  if (!["confirmed", "changes_requested"].includes(input.decision) || !/^[a-f0-9]{64}$/.test(input.snapshotHash)
    || typeof input.note !== "string" || input.note.length > 4000) throw new Error("审核参数无效");
  const note = input.note.trim();
  if (input.decision === "changes_requested" && !note) throw new Error("退回时请填写具体问题");
  return catalog.withTransaction(() => {
    const current = getEpisodeReview(catalog, input.projectId, input.episodeId);
    const receipt = catalog.db.query(`SELECT id, result_hash AS resultHash, decision, note
      FROM episode_review WHERE episode_id = ? AND snapshot_hash = ? ORDER BY rowid DESC LIMIT 1`)
      .get(input.episodeId, input.snapshotHash) as { id: string; resultHash: string; decision: string; note: string } | null;
    if (receipt && receipt.resultHash === current.snapshotHash && receipt.decision === input.decision && receipt.note === note) {
      return { reviewId: receipt.id, alreadyReviewed: true };
    }
    if (current.snapshotHash !== input.snapshotHash) throw new Error("审核期间内容已变化，请刷新并重新检查");
    if (current.hasSuccessor) throw new Error("后续分集已经建立，需通过系列修订处理前序内容，不能直接改变本集确认状态");
    if (input.decision === "confirmed" && current.issues.length) throw new Error(`尚不能确认：${current.issues[0]}`);
    const now = Date.now();
    catalog.db.query("UPDATE production_episode SET review_state = ?, updated_at = ? WHERE id = ?")
      .run(input.decision, now, input.episodeId);
    for (const shot of current.snapshot.shots) {
      catalog.setShotWorkflowState(shot.id, { reviewState: input.decision,
        ...(input.decision === "changes_requested" ? { videoReadiness: "blocked" as const } : {}) });
    }
    if (input.decision === "confirmed") {
      for (const asset of current.snapshot.assets) catalog.setAssetLocked(asset.id, true);
      for (const scene of current.snapshot.scenes) catalog.db.query("UPDATE production_scene SET locked = 1, updated_at = ? WHERE id = ?")
        .run(now, scene.id);
    }
    const reviewId = randomUUID();
    const resultHash = getEpisodeReview(catalog, input.projectId, input.episodeId).snapshotHash;
    catalog.db.query(`INSERT INTO episode_review(id, episode_id, snapshot_hash, result_hash, snapshot_json,
      decision, note, reviewed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'localUser', ?)`)
      .run(reviewId, input.episodeId, input.snapshotHash, resultHash, JSON.stringify(current.snapshot), input.decision, note, now);
    return { reviewId, alreadyReviewed: false };
  });
}

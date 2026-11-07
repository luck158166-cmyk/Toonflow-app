import { createHash, randomUUID } from "node:crypto";
import type { ProductionCatalog } from "./catalog";
import type { ProductionStore } from "./store";
import { getEpisodeSegmentPlan } from "./segmentPlan";
import type { EpisodeQualityReport } from "./episodeQuality";

export type SegmentVideoEvidence = {
  path: string; sha256: string; durationMs: number; width: number; height: number;
  videoCodec: string; audioCodec: string; quality: EpisodeQualityReport;
};
export type SegmentVideoReview = { pictureConfirmed: true; continuityConfirmed: true; audioConfirmed: true; rightsConfirmed: true; note: string };
export type SegmentVideoAdoption = {
  id: string; projectId: string; episodeId: string; inputHash: string; sequence: number; taskId: string;
  version: number; createdAt: number; evidence: SegmentVideoEvidence; review: SegmentVideoReview;
  timeline: ReturnType<typeof getEpisodeSegmentPlan>["snapshot"]["segments"][number]["timeline"];
};

export function readSegmentVideoSource(catalog: ProductionCatalog, store: ProductionStore, projectId: string, taskId: string) {
  const task = store.getTask(taskId); const binding = store.getHostMediaBinding(taskId); const input = binding?.authorization.segmentInput;
  if (task.projectId !== projectId || task.stage !== "video" || !input || input.projectId !== projectId || input.episodeId !== task.episodeId
    || !catalog.getProjectProduction(projectId).episodes.some(episode => episode.id === task.episodeId)) throw new Error("视频缺少可核验的剧集片段归属；不能猜测旧任务对应的镜头");
  const row = catalog.db.query(`SELECT snapshot_json, version FROM episode_segment_plan WHERE project_id = ? AND episode_id = ? AND input_hash = ?`)
    .get(projectId, input.episodeId, input.inputHash) as { snapshot_json: string; version: number } | null;
  if (!row || createHash("sha256").update(row.snapshot_json).digest("hex") !== input.inputHash) throw new Error("视频对应的片段方案快照缺失或已变动");
  const snapshot = JSON.parse(row.snapshot_json) as ReturnType<typeof getEpisodeSegmentPlan>["snapshot"];
  const segment = snapshot.segments.find(item => item.sequence === input.sequence);
  const request = JSON.parse(task.requestJson);
  if (!segment || request.prompt !== segment.requestDraft.prompt || request.duration !== segment.requestDraft.duration
    || request.modelId !== segment.requestDraft.model || request.ratio !== "9:16" || request.resolution !== "1080p") throw new Error("视频请求与保存的片段方案不符");
  return { task, input, segment, planVersion: row.version };
}

export function listSegmentVideoAdoptions(catalog: ProductionCatalog, projectId: string, episodeId: string) {
  const rows = catalog.db.query(`SELECT snapshot_json FROM segment_video_adoption WHERE project_id = ? AND episode_id = ? ORDER BY created_at DESC, version DESC`)
    .all(projectId, episodeId) as Array<{ snapshot_json: string }>;
  return rows.map(row => JSON.parse(row.snapshot_json) as SegmentVideoAdoption);
}

/** Media bytes and decoding are checked by the host immediately before this transaction. */
export function adoptSegmentVideo(catalog: ProductionCatalog, store: ProductionStore, projectId: string, taskId: string,
  evidence: SegmentVideoEvidence, review: SegmentVideoReview, expectedAdoptionId: string | null) {
  if (review.pictureConfirmed !== true || review.continuityConfirmed !== true || review.audioConfirmed !== true || review.rightsConfirmed !== true
    || !review.note.trim() || review.note.length > 2000) throw new Error("请核对实际画面、连续性、音频与使用权，并填写审片说明");
  return catalog.withTransaction(() => {
    const { task, input, segment } = readSegmentVideoSource(catalog, store, projectId, taskId);
    const output = store.getMediaOutput(taskId, "video");
    if (task.state !== "succeeded" || !/^[a-f0-9]{64}$/.test(evidence.sha256) || !evidence.path
      || output?.path !== evidence.path || output.sha256 !== evidence.sha256
      || evidence.width !== 1080 || evidence.height !== 1920 || evidence.videoCodec !== "h264" || evidence.audioCodec !== "aac"
      || !Number.isFinite(evidence.durationMs) || Math.abs(evidence.durationMs - segment.requestDraft.duration * 1000) > 200
      || evidence.quality.formatIssues.length || evidence.quality.truncated) throw new Error("视频技术检查不合格，不能采用");
    const history = listSegmentVideoAdoptions(catalog, projectId, input.episodeId);
    const existing = history.find(item => item.taskId === taskId);
    if (existing) {
      if (existing.evidence.path !== evidence.path || existing.evidence.sha256 !== evidence.sha256) throw new Error("已采用视频的原文件改变");
      return { adoption: existing, created: false };
    }
    const current = getEpisodeSegmentPlan(catalog, projectId, input.episodeId);
    if (current.inputHash !== input.inputHash) throw new Error("剧本、镜头或参考图已变化；保留旧视频，但不能采用到当前方案");
    const previous = history.find(item => item.inputHash === input.inputHash && item.sequence === input.sequence);
    if ((previous?.id ?? null) !== expectedAdoptionId) throw new Error("已采用的片段发生变化，请刷新后再审片");
    const adoption: SegmentVideoAdoption = { id: randomUUID(), projectId, episodeId: input.episodeId, inputHash: input.inputHash,
      sequence: input.sequence, taskId, version: (previous?.version ?? 0) + 1, createdAt: Date.now(), evidence,
      review: { ...review, note: review.note.trim() }, timeline: segment.timeline };
    catalog.db.query(`INSERT INTO segment_video_adoption(id, project_id, episode_id, plan_hash, segment_sequence, task_id, version, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(adoption.id, projectId, input.episodeId, input.inputHash, input.sequence, taskId, adoption.version, JSON.stringify(adoption), adoption.createdAt);
    return { adoption, created: true };
  });
}

export function getEpisodeVideoTimeline(catalog: ProductionCatalog, projectId: string, episodeId: string) {
  const plan = getEpisodeSegmentPlan(catalog, projectId, episodeId);
  const history = listSegmentVideoAdoptions(catalog, projectId, episodeId); let offsetMs = 0;
  const segments = plan.snapshot.segments.map(segment => {
    const adoption = history.find(item => item.inputHash === plan.inputHash && item.sequence === segment.sequence) ?? null;
    const startMs = offsetMs; offsetMs += segment.requestDraft.duration * 1000;
    return { sequence: segment.sequence, startMs, endMs: offsetMs, adoption,
      shots: segment.timeline.map(shot => ({ ...shot, startMs: startMs + shot.start * 1000, endMs: startMs + shot.end * 1000 })) };
  });
  return { projectId, episodeId, inputHash: plan.inputHash, durationMs: offsetMs, segments, history,
    complete: segments.length > 0 && segments.every(segment => !!segment.adoption) };
}

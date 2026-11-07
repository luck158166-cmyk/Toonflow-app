import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "@toonflow/file";
import { adoptSegmentVideo, getEpisodeVideoTimeline, inspectEpisodeQuality, readSegmentVideoSource, type SegmentVideoEvidence, type SegmentVideoReview } from "@toonflow/production";
import type { FfprobeData } from "@toonflow/ffmpeg/types";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import * as mediaTasks from "@/utils/media/tasks";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import { withProduction } from "./index";
import { boundProductionMediaTask, syncProductionMediaTask } from "./mediaTasks";

async function verifiedVideo(directory: string, projectId: string, taskId: string) {
  await syncProductionMediaTask(directory, projectId, taskId, "video");
  const { task } = await boundProductionMediaTask(directory, projectId, taskId, "video");
  const record = await mediaTasks.inspect(directory, taskId); const file = record?.checkpoint.files?.[0];
  if (task.state !== "succeeded" || record?.state !== "succeeded" || !file) throw new Error("视频尚未成功保存，先恢复原任务");
  const resolved = await resolveWorkspacePath(directory, file.path);
  const release = lockWorkspaceFiles([resolved.path]);
  try {
    const info = await lstat(resolved.path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 100 * 1024 * 1024) throw new Error("视频文件无效");
    const bytes = await readFile(resolved.path);
    if (createHash("sha256").update(bytes).digest("hex") !== file.hash) throw new Error("视频文件已变化，不会重新付费生成");
    return { file, bytes, path: resolved.path };
  } finally { release(); }
}

export async function readSegmentVideo(workspace: string, projectId: string, taskId: string) {
  return (await verifiedVideo(await realpath(workspace), projectId, taskId)).bytes;
}

const inspections = new Map<string, Promise<Awaited<ReturnType<typeof inspect>>>>();
export async function inspectSegmentVideo(workspace: string, projectId: string, taskId: string) {
  const directory = await realpath(workspace); const key = JSON.stringify([directory, projectId, taskId]);
  const pending = inspections.get(key); if (pending) return pending;
  const inspection = inspect(directory, projectId, taskId).finally(() => inspections.delete(key));
  inspections.set(key, inspection); return inspection;
}

async function inspect(directory: string, projectId: string, taskId: string) {
  const source = await withProduction(directory, (catalog, store) => readSegmentVideoSource(catalog, store, projectId, taskId));
  const video = await verifiedVideo(directory, projectId, taskId);
  const factory = await createWorkspaceFfmpeg(directory);
  const metadata = await new Promise<FfprobeData>((resolve, reject) => factory.ffprobe(video.path, (error, result) => error ? reject(error) : resolve(result)));
  if (!metadata.format.format_name?.split(",").includes("mp4")) throw new Error("视频封装不是可核验的 MP4");
  const picture = metadata.streams.find(stream => stream.codec_type === "video");
  const audio = metadata.streams.find(stream => stream.codec_type === "audio");
  const quality = await inspectEpisodeQuality(factory, video.path, { expectedDurationSeconds: source.segment.requestDraft.duration });
  // Inspect the actual bytes again after decoding; a path alone is not evidence of unchanged media.
  await verifiedVideo(directory, projectId, taskId);
  const evidence: SegmentVideoEvidence = { path: video.file.path, sha256: video.file.hash, durationMs: Math.round(quality.durationSeconds * 1000),
    width: picture?.width ?? 0, height: picture?.height ?? 0, videoCodec: picture?.codec_name ?? "", audioCodec: audio?.codec_name ?? "", quality };
  const timeline = await withProduction(directory, catalog => getEpisodeVideoTimeline(catalog, projectId, source.input.episodeId));
  const current = timeline.inputHash === source.input.inputHash;
  const adoption = timeline.history.find(item => item.taskId === taskId) ?? null;
  const selected = timeline.segments.find(segment => segment.sequence === source.input.sequence)?.adoption ?? null;
  return { taskId, episodeId: source.input.episodeId, sequence: source.input.sequence, inputHash: source.input.inputHash,
    planVersion: source.planVersion, shots: source.segment.timeline, evidence, current, adoption,
    expectedAdoptionId: current ? selected?.id ?? null : null,
    canAdopt: current && !quality.formatIssues.length && !quality.truncated,
    message: !current ? "这是旧方案的视频，保留预览和历史；当前方案需重新核对"
      : quality.formatIssues.length ? "技术检查未通过，请检查报告"
      : "技术检查不等于内容合格；请播放核对人物、动作、道具、对白与使用权" };
}

export async function adoptProductionSegmentVideo(workspace: string, projectId: string, taskId: string,
  expectedAdoptionId: string | null, review: SegmentVideoReview) {
  const directory = await realpath(workspace);
  const candidate = await inspectSegmentVideo(directory, projectId, taskId);
  return withProduction(directory, (catalog, store) => adoptSegmentVideo(catalog, store, projectId, taskId, candidate.evidence, review, expectedAdoptionId));
}

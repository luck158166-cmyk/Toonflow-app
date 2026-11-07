import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "@toonflow/file";
import { FfmpegSynthesis, getEpisodeVideoTimeline, runSynthesisTask, type EpisodeRenderSpec } from "@toonflow/production";
import { createWorkspaceFfmpeg, prepareWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { withProduction } from "./index";
import { inspectSegmentVideo } from "./segmentVideos";

const renders = new Map<string, Promise<void>>();

/** Assemble adopted segments with their original audio. No model or speech generation is invoked. */
export async function startEpisodeRoughCut(workspace: string, projectId: string, episodeId: string, inputHash: string) {
  const directory = await realpath(workspace);
  const timeline = await withProduction(directory, catalog => getEpisodeVideoTimeline(catalog, projectId, episodeId));
  if (timeline.inputHash !== inputHash || !timeline.complete) throw new Error("当前片段方案尚未全部采用，请先完成审片");
  const adoptions = timeline.segments.map(segment => segment.adoption!);
  const identity = createHash("sha256").update(JSON.stringify(["roughCut.v1", inputHash, adoptions.map(item => item.id)])).digest("hex");
  const idempotencyKey = `roughCut:${projectId}:${episodeId}:${identity}`;
  const existing = await withProduction(directory, (_catalog, store) => store.findTaskByIdempotencyKey(idempotencyKey));
  const key = JSON.stringify([directory, projectId, episodeId, identity]);
  if (existing && (existing.state === "succeeded" || renders.has(key))) return { taskId: existing.id, state: existing.state, message: "复用同一合成任务，不生成新视频" };
  await prepareWorkspaceFfmpeg();
  for (const adoption of adoptions) {
    const candidate = await inspectSegmentVideo(directory, projectId, adoption.taskId);
    if (candidate.evidence.sha256 !== adoption.evidence.sha256 || candidate.evidence.quality.formatIssues.length || !candidate.current) {
      throw new Error("已采用片段的文件或方案发生变化，停止合成");
    }
  }
  const created = await withProduction(directory, (catalog, store) => {
    const current = getEpisodeVideoTimeline(catalog, projectId, episodeId);
    if (current.inputHash !== inputHash || JSON.stringify(current.segments.map(item => item.adoption?.id)) !== JSON.stringify(adoptions.map(item => item.id))) {
      throw new Error("审片选择已经变化，请刷新时间线");
    }
    const spec: EpisodeRenderSpec = { projectId, episodeId, aspectRatio: "9:16", width: 1080, height: 1920, videoCodec: "h264", audioCodec: "aac",
      clips: adoptions.map(adoption => ({ shotId: adoption.timeline[0]!.shotId, taskId: adoption.taskId, slot: "video",
        path: adoption.evidence.path, sha256: adoption.evidence.sha256,
        durationMs: (adoption.timeline.at(-1)!.end - adoption.timeline[0]!.start) * 1000,
        segmentInput: { inputHash: adoption.inputHash, sequence: adoption.sequence } })),
      audioTracks: [], subtitles: null, bgm: null, outputPath: `exports/production/${episodeId}/${identity}.mp4` };
    return store.createSynthesisTask(idempotencyKey, spec);
  });
  if (!renders.has(key) && created.task.state !== "succeeded") {
    const pending = withProduction(directory, async (_catalog, store) => {
      const result = await runSynthesisTask(store, created.task.id, new FfmpegSynthesis(directory, () => createWorkspaceFfmpeg(directory)));
      if (result.status === "failed") console.error("本地审片版合成失败", created.task.id, result.error);
    }).catch(cause => { console.error("本地审片版任务失败", created.task.id, cause); }).finally(() => renders.delete(key));
    renders.set(key, pending);
  }
  return { taskId: created.task.id, state: created.task.state, message: "正在本地合成审片版，保留片段原声；尚未添加独立配音、字幕和配乐" };
}

export async function readEpisodeRoughCut(workspace: string, projectId: string, taskId: string) {
  const directory = await realpath(workspace);
  const output = await withProduction(directory, (catalog, store) => {
    const task = store.getTask(taskId); const record = store.getSynthesisExport(taskId); const output = store.getMediaOutput(taskId, "episode");
    if (!catalog.getProjectProduction(projectId).episodes.some(episode => episode.id === task.episodeId)
      || task.projectId !== projectId || task.stage !== "synthesis" || task.state !== "succeeded" || !record || !output
      || record.spec.outputPath !== output.path) throw new Error("当前故事没有已完成的这份合成文件");
    return output;
  });
  const resolved = await resolveWorkspacePath(directory, output.path); const info = await lstat(resolved.path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 512 * 1024 * 1024) throw new Error("合成文件无效或超过预览大小上限");
  const bytes = await readFile(resolved.path);
  if (createHash("sha256").update(bytes).digest("hex") !== output.sha256) throw new Error("合成文件哈希不符，保留记录以便核对");
  return bytes;
}

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { FfmpegFactory, FfprobeData } from "@toonflow/ffmpeg/types";

export type QualityInterval = { kind: "black" | "silence"; startSeconds: number; endSeconds: number };
export type EpisodeQualityReport = {
  version: 1; checkedAt: number; status: "passed_rules" | "needs_review";
  durationSeconds: number; formatIssues: string[]; intervals: QualityInterval[]; truncated: boolean;
  policy: { minimumBlackSeconds: number; minimumSilenceSeconds: number; silenceNoiseDb: number };
};

/** Technical flags require editorial review: an intentional dark scene or pause is not automatically a failure. */
export async function inspectEpisodeQuality(factory: FfmpegFactory, path: string, options: {
  expectedDurationSeconds?: number; minimumBlackSeconds?: number; minimumSilenceSeconds?: number; silenceNoiseDb?: number;
} = {}, signal = AbortSignal.timeout(10 * 60_000)): Promise<EpisodeQualityReport> {
  const policy = { minimumBlackSeconds: options.minimumBlackSeconds ?? 0.5,
    minimumSilenceSeconds: options.minimumSilenceSeconds ?? 1, silenceNoiseDb: options.silenceNoiseDb ?? -50 };
  if (!Number.isFinite(policy.minimumBlackSeconds) || policy.minimumBlackSeconds <= 0
    || !Number.isFinite(policy.minimumSilenceSeconds) || policy.minimumSilenceSeconds <= 0
    || !Number.isFinite(policy.silenceNoiseDb) || policy.silenceNoiseDb < -100 || policy.silenceNoiseDb > 0
    || (options.expectedDurationSeconds !== undefined && (!Number.isFinite(options.expectedDurationSeconds) || options.expectedDurationSeconds <= 0))) {
    throw new TypeError("Invalid quality inspection policy.");
  }
  signal.throwIfAborted();
  const metadata = await new Promise<FfprobeData>((resolve, reject) => factory.ffprobe(path, (error, data) => error ? reject(error) : resolve(data)));
  const durationSeconds = Number(metadata.format.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("Cannot inspect media with an invalid duration.");
  const video = metadata.streams.find(stream => stream.codec_type === "video");
  const audio = metadata.streams.find(stream => stream.codec_type === "audio");
  const formatIssues: string[] = [];
  if (!video) formatIssues.push("missing_video");
  else {
    if (video.width !== 1080 || video.height !== 1920) formatIssues.push("unexpected_dimensions");
    if (video.codec_name !== "h264") formatIssues.push("unexpected_video_codec");
    if (video.pix_fmt !== "yuv420p") formatIssues.push("unexpected_pixel_format");
  }
  if (!audio) formatIssues.push("missing_audio");
  else if (audio.codec_name !== "aac") formatIssues.push("unexpected_audio_codec");
  if (options.expectedDurationSeconds !== undefined && Math.abs(durationSeconds - options.expectedDurationSeconds) > 0.2) {
    formatIssues.push("unexpected_duration");
  }
  if (!video && !audio) throw new Error("Media contains no inspectable streams.");
  const intervals: QualityInterval[] = [];
  let truncated = false;
  const add = (kind: QualityInterval["kind"], start: number, end: number) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("Invalid quality detector timestamps.");
    if (intervals.length >= 10_000) { truncated = true; return; }
    intervals.push({ kind, startSeconds: Math.max(0, start), endSeconds: Math.min(durationSeconds, end) });
  };
  let silenceStart: number | undefined;
  let parseFailure: unknown;
  const command = factory(path).output(join(dirname(path), `.quality-${randomUUID()}.null`)).format("null")
    .outputOptions("-loglevel", "info", "-threads", "2", "-filter_threads", "1");
  if (video) command.videoFilters(`blackdetect=d=${policy.minimumBlackSeconds}:pic_th=0.98:pix_th=0.1`).outputOptions("-map", "0:v:0");
  if (audio) command.audioFilters(`silencedetect=n=${policy.silenceNoiseDb}dB:d=${policy.minimumSilenceSeconds}`).outputOptions("-map", "0:a:0");
  command.on("stderr", (line: string) => {
    try {
      const black = /black_start:([\d.e+-]+)\s+black_end:([\d.e+-]+)/.exec(line);
      if (black) add("black", Number(black[1]), Number(black[2]));
      const start = /silence_start:\s*([\d.e+-]+)/.exec(line);
      if (start) silenceStart = Number(start[1]);
      const end = /silence_end:\s*([\d.e+-]+)/.exec(line);
      if (end && silenceStart !== undefined) { add("silence", silenceStart, Number(end[1])); silenceStart = undefined; }
    } catch (error) { parseFailure = error; }
  });
  signal.throwIfAborted();
  const cancel = () => command.kill("SIGKILL");
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      command.on("start", () => { if (signal.aborted) cancel(); });
      command.on("error", error => reject(signal.aborted ? signal.reason : error));
      command.on("end", () => signal.aborted ? reject(signal.reason) : resolve());
      command.run();
    });
  } finally { signal.removeEventListener("abort", cancel); }
  if (parseFailure) throw parseFailure;
  if (silenceStart !== undefined) add("silence", silenceStart, durationSeconds);
  intervals.sort((a, b) => a.startSeconds - b.startSeconds || a.kind.localeCompare(b.kind));
  return { version: 1, checkedAt: Date.now(), status: formatIssues.length || intervals.length || truncated ? "needs_review" : "passed_rules",
    durationSeconds, formatIssues, intervals, policy, truncated };
}

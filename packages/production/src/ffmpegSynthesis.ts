import { createHash, randomUUID } from "node:crypto";
import { dirname, basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createReadStream, lstat, realpath, mkdir, readFile, writeFile, writeAtomic, link, unlink } from "@toonflow/file";
import type { FfmpegFactory, FfmpegCommand, FfprobeData } from "@toonflow/ffmpeg/types";
import type { EpisodeRenderSpec } from "./store";
import type { SynthesisPort } from "./synthesisWorker";
import { inspectEpisodeQuality } from "./episodeQuality";
import type { EpisodeQualityReport } from "./episodeQuality";

function manifestJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(manifestJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${manifestJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function inspectFile(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function workspacePath(root: string, value: string) {
  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[\x00-\x1f:<>"|?*]|[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Invalid render workspace path.");
  return join(root, ...parts);
}

function assertWithin(root: string, actual: string) {
  const offset = relative(root, actual);
  if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error("Render input escapes the workspace.");
}

function probe(factory: FfmpegFactory, path: string) {
  return new Promise<FfprobeData>((resolve, reject) => factory.ffprobe(path, (error, result) => error ? reject(error) : resolve(result)));
}

async function execute(command: FfmpegCommand, signal: AbortSignal) {
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
}

/** The host supplies createWorkspaceFfmpeg(root), reusing its configured tools and path policy. */
export class FfmpegSynthesis implements SynthesisPort {
  constructor(private readonly directory: string, private readonly factory: () => Promise<FfmpegFactory>) {}

  async render(spec: EpisodeRenderSpec, signal = AbortSignal.timeout(10 * 60_000)) {
    if (spec.width !== 1080 || spec.height !== 1920 || spec.aspectRatio !== "9:16"
      || spec.videoCodec !== "h264" || spec.audioCodec !== "aac" || !spec.clips.length) throw new Error("Invalid episode output format.");
    const root = await realpath(resolve(this.directory));
    const output = workspacePath(root, spec.outputPath);
    const inputSha256 = createHash("sha256").update(manifestJson(spec)).digest("hex");
    const qualityReportPath = `${spec.outputPath}.quality.json`;
    // Create each parent separately and reject junctions before writing any output.
    let parent = root;
    for (const part of relative(root, dirname(output)).split(sep).filter(Boolean)) {
      parent = join(parent, part);
      try { await mkdir(parent); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const state = await lstat(parent);
      if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("Render parent must be an ordinary directory.");
    }
    const receiptState = await inspectFile(`${output}.quality.json`);
    let receipt: (EpisodeQualityReport & { inputSha256: string; sha256: string; mediaPath: string }) | undefined;
    if (receiptState) {
      if (!receiptState.isFile() || receiptState.isSymbolicLink() || receiptState.size > 4 * 1024 * 1024) throw new Error("Invalid synthesis receipt.");
      receipt = JSON.parse(await readFile(`${output}.quality.json`, "utf8"));
      if (!receipt || receipt.version !== 1 || receipt.inputSha256 !== inputSha256 || receipt.mediaPath !== spec.outputPath
        || !/^[a-f0-9]{64}$/.test(receipt.sha256) || !["passed_rules", "needs_review"].includes(receipt.status)
        || !Array.isArray(receipt.intervals) || !Array.isArray(receipt.formatIssues)) throw new Error("Synthesis receipt does not match this manifest.");
    }
    const existingOutput = await inspectFile(output);
    if (existingOutput) {
      if (!receipt || !existingOutput.isFile() || existingOutput.isSymbolicLink() || await digest(output) !== receipt.sha256) {
        throw new Error("Existing render cannot be adopted or overwritten.");
      }
      return { sha256: receipt.sha256, quality: receipt, qualityReportPath };
    }
    const verified = async (input: { path: string; sha256: string }) => {
      const actual = await realpath(workspacePath(root, input.path));
      assertWithin(root, actual);
      if (await digest(actual) !== input.sha256.toLowerCase()) throw new Error("Render input hash changed.");
      return actual;
    };
    const factory = await this.factory();
    const command = factory();
    const filters: string[] = [];
    let durationMs = 0;
    for (let index = 0; index < spec.clips.length; index++) {
      const clip = spec.clips[index];
      if (!Number.isSafeInteger(clip.durationMs) || clip.durationMs <= 0) throw new Error("Invalid clip duration.");
      const path = await verified(clip);
      const metadata = await probe(factory, path);
      if (!metadata.streams.some(stream => stream.codec_type === "video")) throw new Error("Clip has no video stream.");
      if (Number(metadata.format.duration) * 1000 + 100 < clip.durationMs) throw new Error("Clip is shorter than the render manifest.");
      command.input(path);
      const seconds = clip.durationMs / 1000;
      durationMs += clip.durationMs;
      filters.push(`[${index}:v:0]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,trim=duration=${seconds},setpts=PTS-STARTPTS[v${index}]`);
      const audio = metadata.streams.some(stream => stream.codec_type === "audio")
        ? `[${index}:a:0]aresample=48000,aformat=channel_layouts=stereo,apad`
        : "anullsrc=r=48000:cl=stereo";
      filters.push(`${audio},atrim=duration=${seconds},asetpts=PTS-STARTPTS[a${index}]`);
    }
    const seconds = durationMs / 1000;
    filters.push(`${spec.clips.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${spec.clips.length}:v=1:a=1[vbase][abase]`);
    const audioLabels = ["[abase]"];
    let inputIndex = spec.clips.length;
    for (const track of spec.audioTracks) {
      if (!Number.isSafeInteger(track.startMs) || track.startMs < 0 || track.startMs >= durationMs) throw new Error("Audio track starts outside the episode.");
      command.input(await verified(track));
      filters.push(`[${inputIndex}:a:0]aresample=48000,aformat=channel_layouts=stereo,adelay=${track.startMs}:all=1,apad,atrim=duration=${seconds}[voice${inputIndex}]`);
      audioLabels.push(`[voice${inputIndex++}]`);
    }
    if (spec.bgm) {
      if (!Number.isFinite(spec.bgm.gainDb) || spec.bgm.gainDb < -60 || spec.bgm.gainDb > 12) throw new Error("Invalid BGM gain.");
      command.input(await verified(spec.bgm)).inputOptions("-stream_loop", "-1");
      filters.push(`[${inputIndex}:a:0]aresample=48000,aformat=channel_layouts=stereo,volume=${spec.bgm.gainDb}dB,atrim=duration=${seconds}[bgm]`);
      audioLabels.push("[bgm]");
    }
    filters.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=first:normalize=0,alimiter=limit=0.95:level=0[aout]`);
    const subtitleSource = await verified(spec.subtitles);
    const extension = extname(subtitleSource).toLowerCase();
    if (![".srt", ".ass"].includes(extension)) throw new Error("Subtitles must be SRT or ASS.");
    const subtitleCopy = join(root, `.render-${randomUUID()}${extension}`);
    const temporaryOutput = join(dirname(output), `.render-${randomUUID()}.mp4`);
    await writeFile(subtitleCopy, await readFile(subtitleSource), { flag: "wx" });
    try {
      filters.push(`[vbase]subtitles=filename='${basename(subtitleCopy)}'[vout]`);
      command.complexFilter(filters).outputOptions("-map", "[vout]", "-map", "[aout]", "-pix_fmt", "yuv420p",
        "-preset", "fast", "-crf", "20", "-movflags", "+faststart", "-threads", "2", "-filter_complex_threads", "1")
        .videoCodec("libx264").audioCodec("aac").audioBitrate(192).duration(seconds).format("mp4").output(temporaryOutput);
      await execute(command, signal);
      const metadata = await probe(factory, temporaryOutput);
      const video = metadata.streams.find(stream => stream.codec_type === "video");
      const audio = metadata.streams.find(stream => stream.codec_type === "audio");
      if (video?.width !== 1080 || video.height !== 1920 || video.codec_name !== "h264" || video.pix_fmt !== "yuv420p"
        || audio?.codec_name !== "aac" || !Number.isFinite(Number(metadata.format.duration))
        || Math.abs(Number(metadata.format.duration) - seconds) > 0.2) throw new Error("Rendered episode failed format validation.");
      const sha256 = await digest(temporaryOutput);
      const quality = await inspectEpisodeQuality(factory, temporaryOutput, { expectedDurationSeconds: seconds }, signal);
      await writeAtomic(`${output}.quality.json`, JSON.stringify({ ...quality, mediaPath: spec.outputPath, sha256, inputSha256 }, null, 2), { exclusive: !receipt });
      signal.throwIfAborted();
      await link(temporaryOutput, output);
      return { sha256, quality, qualityReportPath };
    } finally {
      await unlink(subtitleCopy);
      try { await unlink(temporaryOutput); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}

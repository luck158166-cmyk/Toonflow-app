import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "@toonflow/file";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createFfmpeg } from "@toonflow/ffmpeg";
import { inspectEpisodeQuality } from "../packages/production/src/episodeQuality";

const tools = process.env.TOONFLOW_QA_FFMPEG_DIR;
it.skipIf(!tools)("detects real black/silent intervals, missing audio and corrupt media", async () => {
  const root = mkdtempSync(join(tmpdir(), "toonflow-quality-"));
  const factory = createFfmpeg(root);
  factory.setFfmpegPath(join(tools!, "ffmpeg.exe"));
  factory.setFfprobePath(join(tools!, "ffprobe.exe"));
  const generate = async (color: string, audio: "silent" | "tone" | "none", name: string) => {
    const args = [join(tools!, "ffmpeg.exe"), "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "lavfi", "-i", `color=c=${color}:s=1080x1920:r=10:d=1`];
    if (audio !== "none") args.push("-f", "lavfi", "-i", audio === "silent" ? "anullsrc=r=48000:cl=stereo" : "sine=frequency=440:duration=1");
    args.push("-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", name);
    const child = Bun.spawn(args, { cwd: root, stdout: "ignore", stderr: "pipe" });
    const error = new Response(child.stderr).text();
    if (await child.exited) throw new Error(await error);
    await error;
  };
  try {
    await generate("black", "silent", "fault.mp4");
    const report = await inspectEpisodeQuality(factory, join(root, "fault.mp4"), { minimumBlackSeconds: 0.2, minimumSilenceSeconds: 0.2 });
    expect(report.status).toBe("needs_review");
    expect(report.formatIssues).toEqual([]);
    const black = report.intervals.find(item => item.kind === "black")!;
    const silence = report.intervals.find(item => item.kind === "silence")!;
    expect(black.startSeconds).toBeCloseTo(0, 1);
    expect(black.endSeconds).toBeGreaterThanOrEqual(0.8);
    expect(silence.startSeconds).toBeCloseTo(0, 1);
    expect(silence.endSeconds).toBeGreaterThanOrEqual(0.9);
    await generate("green", "tone", "healthy.mp4");
    const healthy = await inspectEpisodeQuality(factory, join(root, "healthy.mp4"), { minimumBlackSeconds: 0.2, minimumSilenceSeconds: 0.2 });
    expect(healthy.status).toBe("passed_rules");
    expect(healthy.intervals).toEqual([]);
    await generate("green", "none", "noAudio.mp4");
    const noAudio = await inspectEpisodeQuality(factory, join(root, "noAudio.mp4"));
    expect(noAudio.status).toBe("needs_review");
    expect(noAudio.formatIssues).toContain("missing_audio");
    writeFileSync(join(root, "broken.mp4"), "invalid media bytes");
    await expect(inspectEpisodeQuality(factory, join(root, "broken.mp4"))).rejects.toThrow();
  } finally {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe QA cleanup path.");
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

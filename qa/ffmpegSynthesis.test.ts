import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, constants } from "@toonflow/file";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createFfmpeg } from "@toonflow/ffmpeg";
import { ProductionStore, type EpisodeRenderSpec } from "../packages/production/src/store";
import { runSynthesisTask } from "../packages/production/src/synthesisWorker";
import { FfmpegSynthesis } from "../packages/production/src/ffmpegSynthesis";

const toolsDirectory = process.env.TOONFLOW_QA_FFMPEG_DIR;
it.skipIf(!toolsDirectory)("renders eight clips with native audio, extra audio, subtitles and BGM, then re-exports locally", async () => {
  const root = mkdtempSync(join(tmpdir(), "toonflow-render-"));
  let db = new Database(join(root, "production.db"));
  const hash = (path: string) => createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
  const ffmpegPath = join(resolve(toolsDirectory!), "ffmpeg.exe");
  const ffprobePath = join(resolve(toolsDirectory!), "ffprobe.exe");
  const command = async (args: string[]) => {
    const child = Bun.spawn([ffmpegPath, "-hide_banner", "-loglevel", "error", "-nostdin", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const stderr = new Response(child.stderr).text();
    if (await child.exited) throw new Error(await stderr);
    await stderr;
  };
  try {
    let store = new ProductionStore(db);
    const clips: EpisodeRenderSpec["clips"] = [];
    const colors = ["red", "green", "blue", "yellow", "purple", "cyan", "orange", "navy"];
    for (let i = 0; i < colors.length; i++) {
      const path = `clip${i}.mp4`;
      await command(["-f", "lavfi", "-i", `color=c=${colors[i]}:s=270x480:r=30:d=0.5`, "-f", "lavfi", "-i", `sine=frequency=${300 + i * 50}:duration=0.5`,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path]);
      const task = store.createTask({ idempotencyKey: path, projectId: "p", episodeId: "e", shotId: `shot${i}`,
        stage: "video", provider: "mock", requestJson: "{}", estimatedCostMicros: 0, currency: "CNY", billable: false }).task;
      store.beginSubmission(task.id);
      const sha256 = hash(path);
      store.completeTask(task.id, { slot: "primary", path, sha256 });
      clips.push({ shotId: `shot${i}`, taskId: task.id, slot: "primary", path, sha256, durationMs: 500 });
    }
    await command(["-f", "lavfi", "-i", "sine=frequency=880:duration=0.5", "voice.wav"]);
    await command(["-f", "lavfi", "-i", "sine=frequency=100:duration=1", "bgm.wav"]);
    const voice = store.createTask({ idempotencyKey: "voice", projectId: "p", episodeId: "e", stage: "speech", provider: "mock",
      requestJson: "{}", estimatedCostMicros: 0, currency: "CNY", billable: false }).task;
    store.beginSubmission(voice.id);
    store.completeTask(voice.id, { slot: "primary", path: "voice.wav", sha256: hash("voice.wav") });
    writeFileSync(join(root, "captions.srt"), "1\n00:00:00,000 --> 00:00:04,000\nMOCK TECHNICAL RENDER - NOT A GENERATED STORY\n");
    const spec: EpisodeRenderSpec = { projectId: "p", episodeId: "e", aspectRatio: "9:16", width: 1080, height: 1920,
      videoCodec: "h264", audioCodec: "aac", clips,
      audioTracks: [{ type: "narration", taskId: voice.id, slot: "primary", path: "voice.wav", sha256: hash("voice.wav"), startMs: 1000 }],
      subtitles: { path: "captions.srt", sha256: hash("captions.srt"), language: "en" },
      bgm: { path: "bgm.wav", sha256: hash("bgm.wav"), gainDb: -18 }, outputPath: "exports/first.mp4" };
    const factory = createFfmpeg(root);
    factory.setFfmpegPath(ffmpegPath);
    factory.setFfprobePath(ffprobePath);
    const renderer = new FfmpegSynthesis(root, async () => factory);
    const first = store.createSynthesisTask("render1", spec);
    const firstResult = await runSynthesisTask(store, first.task.id, renderer);
    if (firstResult.status === "failed") throw firstResult.error;
    expect(firstResult.status).toBe("succeeded");
    if (firstResult.status !== "succeeded") throw new Error("Render did not finish.");
    expect(firstResult.qualityReportPath).toBe("exports/first.mp4.quality.json");
    const report = JSON.parse(readFileSync(join(root, firstResult.qualityReportPath!), "utf8"));
    expect(report.sha256).toBe(hash("exports/first.mp4"));
    expect(report.formatIssues).toEqual([]);
    expect(report.durationSeconds).toBeCloseTo(4, 1);
    expect((await runSynthesisTask(store, first.task.id, renderer)).status).toBe("already_succeeded");
    writeFileSync(join(root, "captions2.srt"), "1\n00:00:00,000 --> 00:00:04,000\nREVISED SUBTITLES - SAME SOURCE CLIPS\n");
    const revised = store.createSynthesisTask("render2", { ...spec, outputPath: "exports/revised.mp4",
      subtitles: { ...spec.subtitles, path: "captions2.srt", sha256: hash("captions2.srt") }, bgm: { ...spec.bgm!, gainDb: -24 } });
    const revisedResult = await runSynthesisTask(store, revised.task.id, renderer);
    if (revisedResult.status === "failed") throw revisedResult.error;
    expect(revisedResult.status).toBe("succeeded");
    for (const clip of clips) {
      expect(hash(clip.path)).toBe(clip.sha256);
      expect(store.getTask(clip.taskId).attempt).toBe(1);
    }
    expect(hash("exports/first.mp4")).not.toBe(hash("exports/revised.mp4"));
    const interruptedSpec = { ...spec, outputPath: "exports/interrupted.mp4" };
    const interrupted = store.createSynthesisTask("renderInterrupted", interruptedSpec);
    store.beginSubmission(interrupted.task.id);
    const published = await renderer.render(interrupted.export.spec);
    db.close(); // Exit after MP4 publication, before completeTask writes the output row.
    db = new Database(join(root, "production.db"));
    store = new ProductionStore(db);
    store.recoverInterrupted();
    expect(store.getTask(interrupted.task.id).state).toBe("reconcile_required");
    let factoryCalls = 0;
    const recoveryRenderer = new FfmpegSynthesis(root, async () => { factoryCalls++; throw new Error("FFmpeg is unavailable"); });
    const recovered = await runSynthesisTask(store, interrupted.task.id, recoveryRenderer);
    if (recovered.status === "failed") throw recovered.error;
    expect(recovered.status).toBe("succeeded");
    expect(factoryCalls).toBe(0);
    expect(hash("exports/interrupted.mp4")).toBe(published.sha256);
    for (const clip of clips) expect(store.getTask(clip.taskId).attempt).toBe(1);
    await expect(recoveryRenderer.render({ ...interruptedSpec, bgm: { ...spec.bgm!, gainDb: -30 } })).rejects.toThrow("manifest");
    writeFileSync(join(root, "exports/interrupted.mp4"), "tampered output");
    await expect(recoveryRenderer.render(interruptedSpec)).rejects.toThrow("cannot be adopted");
    expect(factoryCalls).toBe(0);
    if (process.env.TOONFLOW_QA_RENDER_OUTPUT) copyFileSync(join(root, "exports/first.mp4"), process.env.TOONFLOW_QA_RENDER_OUTPUT, constants.COPYFILE_EXCL);
  } finally {
    db.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe render cleanup path.");
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);

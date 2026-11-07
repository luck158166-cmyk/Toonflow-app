import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from "@toonflow/file";
import { target } from "@toonflow/ffmpeg";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createShotFixture, bindFixtureImages, scenicDraft } from "./shotPreparationFixture";
import express from "../apps/server/node_modules/express";
import { getEpisodeSegmentPlan, saveEpisodeSegmentPlan } from "../packages/production/src/segmentPlan";
import { reviewSegmentPreflight } from "../packages/production/src/segmentExecution";

const root = process.argv[2]!; const ui = process.argv.includes("--ui");
if (!root || !process.env.TOONFLOW_QA_FFMPEG_DIR) throw new Error("QA requires an isolated directory and local FFmpeg");
process.env.TOONFLOW_DATA_DIR = join(root, "data"); process.env.NODE_ENV = "dev";
process.env.PATH = process.env.TOONFLOW_QA_FFMPEG_DIR + ";" + process.env.PATH;
const directory = join(root, "workspace"); mkdirSync(directory, { recursive: true });
const toolDirectory = join(root, "data/ffmpeg", target); mkdirSync(toolDirectory, { recursive: true });
for (const name of ["ffmpeg.exe", "ffprobe.exe"]) copyFileSync(join(process.env.TOONFLOW_QA_FFMPEG_DIR, name), join(toolDirectory, name));
const media: Buffer[] = [];
for (const color of ["blue", "orange"]) {
  const path = join(root, color + ".mp4");
  const child = Bun.spawn([join(process.env.TOONFLOW_QA_FFMPEG_DIR, "ffmpeg.exe"), "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "lavfi", "-i", `color=c=${color}:s=1080x1920:r=24:d=4`, "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-t", "4", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", path], { stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(child.stderr).text(); if (await child.exited) throw new Error(await stderr); await stderr;
  media.push(readFileSync(path));
}
const calls: string[] = []; let nextMedia = 0; const supplied = new Map<string, Buffer>(); const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("http://127.0.0.1:")) return nativeFetch(input, init);
  const method = init?.method ?? "GET"; calls.push(method + " " + url);
  if (url === "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks" && method === "POST") {
    const id = "qaVideo" + supplied.size; supplied.set(id, nextMedia < 2 ? media[nextMedia++]! : Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"));
    return Response.json({ id });
  }
  const id = url.split("/").at(-1)!;
  if (url.includes("/contents/generations/tasks/") && supplied.has(id)) return Response.json({ id, model: "doubao-seedance-2-5-260628", status: "succeeded", content: { video_url: `https://media.example.test/${id}` } });
  if (url.startsWith("https://media.example.test/") && supplied.has(id)) return new Response(supplied.get(id)!);
  throw new Error("QA blocked external request: " + url);
}, nativeFetch);
const { default: initializePlugins } = await import("../apps/server/src/utils/plugins/initialize");
await initializePlugins(join(root, "data/providers"), resolve("packages/providers/src/media"), ["volcengine.ts"]);
const { default: u } = await import("../apps/server/src/utils");
u.conf.set("settings.mediaProviderConfigs.volcengine", { apiKey: "qaNeverRealKey" }); u.conf.set("settings.ffmpeg", { mode: "download" });
// Use a known PNG fixture, not a generated production asset.
const png = Buffer.from(await new Bun.Image(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGEkAAAAASUVORK5CYII=", "base64")).resize(320, 320).png().buffer());
writeFileSync(join(directory, "input.png"), png);
const original = await u.production.preserveReferenceImage(directory, "input.png", createHash("sha256").update(png).digest("hex"));
async function fixture() {
  return u.production.withProduction(directory, (catalog, store) => {
    const fixture = createShotFixture(catalog, draft => { scenicDraft(draft); draft.shots.forEach(shot => { shot.durationMs = 4000; shot.sceneContext = { sceneSequence: 1, isolate: true, reason: "QA 独立片段验证" }; }); });
    bindFixtureImages(catalog, fixture.projectId, original); store.setBudget(1000000, "CNY");
    store.globalBudgets.recordPriceRule({ provider: "volcengine", modelId: "doubao-seedance-2-5-260628", unit: "seedance25NoVideo1080SecondCeiling", unitSize: 1,
      unitPriceMicros: 100, currency: "CNY", sourceUrl: "https://example.test/qa-price", effectiveAt: 1, recordedBy: "qa" });
    const plan = getEpisodeSegmentPlan(catalog, fixture.projectId, fixture.episodeId); saveEpisodeSegmentPlan(catalog, fixture.projectId, fixture.episodeId, plan.inputHash);
    for (const segment of plan.snapshot.segments) reviewSegmentPreflight(catalog, { ...fixture, inputHash: plan.inputHash, sequence: segment.sequence },
      { actionConfirmed: true, continuityConfirmed: true, dialogueConfirmed: true, referencesConfirmed: true, note: "QA 色块及纯音，不是生产内容" });
    return { ...fixture, inputHash: plan.inputHash };
  });
}
const project = await fixture();
const app = express(); app.use(express.json());
for (const name of ["previewSegmentVideo", "runSegmentVideo", "recoverVideoTask", "inspectSegmentVideo", "readSegmentVideo", "adoptSegmentVideo", "getVideoTimeline", "runEpisodeRoughCut", "readEpisodeRoughCut", "getProjectProduction"]) {
  app.use("/api/production/" + name, (await import("../apps/server/src/routes/production/" + name + ".ts")).default);
}
app.get("/qa/referenceFixture", async (_req, res) => res.json({ directory, ...project,
  ...await u.production.withProduction(directory, (catalog, store) => ({ episodes: catalog.getProjectProduction(project.projectId).episodes, tasks: store.listProjectTasks(project.projectId) })) }));
app.use("/api", (_req, res) => res.status(403).json({ message: "QA only" }));
app.use((cause: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(cause.status ?? 500).json({ message: cause.message }));
const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing QA address");
const base = "http://127.0.0.1:" + address.port;
const post = async (name: string, body: object) => { const response = await fetch(base + "/api/production/" + name, { method: "POST",
  headers: { origin: base, "x-toonflow-workspace": "1", "content-type": "application/json" }, body: JSON.stringify({ directory, ...body }) }); return { status: response.status, body: await response.json() as any }; };
const get = async (name: string, params: Record<string, string>, binary = false) => {
  const response = await fetch(base + "/api/production/" + name + "?" + new URLSearchParams({ directory, ...params }), { headers: { origin: base, "x-toonflow-workspace": "1" } });
  return { status: response.status, body: binary && response.ok ? Buffer.from(await response.arrayBuffer()) : await response.json() as any };
};
async function generate(input: typeof project, sequence: number) {
  const preview = await post("previewSegmentVideo", { ...input, sequence });
  if (!preview.body.data?.canSubmit) throw new Error(JSON.stringify(preview));
  const run = await post("runSegmentVideo", { ...input, sequence, approval: { approved: true, maxCalls: 1, maxCostMicros: 1000, planHash: preview.body.data.planHash } });
  const taskId = run.body.data?.taskId; if (!taskId) throw new Error(JSON.stringify(run));
  await u.mediaTasks.wait(directory, taskId); await post("recoverVideoTask", { projectId: input.projectId, taskId }); return taskId as string;
}
const taskIds = [await generate(project, 1), await generate(project, 2)];
if (ui) {
  const { createServer } = await import("../apps/web/node_modules/vite/dist/node/index.js");
  const vite = await createServer({ configFile: resolve("apps/web/vite.config.ts"), root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "mpa" });
  app.use(vite.middlewares); console.log("QA " + base + "/qa/studioPreview.html?stage=videoAdoption " + root);
  process.on("SIGINT", () => { void vite.close().finally(() => process.exit(0)); });
} else {
  const request = { projectId: project.projectId, taskId: taskIds[0]! };
  const before = await get("getVideoTimeline", { projectId: project.projectId, episodeId: project.episodeId });
  const incomplete = await post("runEpisodeRoughCut", project);
  const candidate = await post("inspectSegmentVideo", request);
  const bytes = await get("readSegmentVideo", request, true);
  const wrongProject = await post("inspectSegmentVideo", { ...request, projectId: randomUUID() });
  const review = { pictureConfirmed: true, continuityConfirmed: true, audioConfirmed: true, rightsConfirmed: true, note: "QA 色块及纯音，仅验证技术链路" };
  const noReview = await post("adoptSegmentVideo", { ...request, expectedAdoptionId: null, review: { ...review, rightsConfirmed: false } });
  const conflict = await post("adoptSegmentVideo", { ...request, expectedAdoptionId: randomUUID(), review });
  const adopted = await Promise.all([post("adoptSegmentVideo", { ...request, expectedAdoptionId: null, review }), post("adoptSegmentVideo", { ...request, expectedAdoptionId: null, review })]);
  const second = await post("adoptSegmentVideo", { projectId: project.projectId, taskId: taskIds[1], expectedAdoptionId: null, review });
  const timeline = await get("getVideoTimeline", { projectId: project.projectId, episodeId: project.episodeId });
  const started = await Promise.all([post("runEpisodeRoughCut", project), post("runEpisodeRoughCut", project)]);
  const renderId = started[0]!.body.data?.taskId; if (!renderId) throw new Error(JSON.stringify({ candidate, adopted, second, timeline, started }));
  const deadline = Date.now() + 90000; let renderTask;
  do {
    renderTask = await u.production.withProduction(directory, (_catalog, store) => store.getTask(renderId));
    if (["succeeded", "failed"].includes(renderTask.state)) break;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  const rendered = await get("readEpisodeRoughCut", { projectId: project.projectId, taskId: renderId }, true);
  const repeated = await post("runEpisodeRoughCut", project);
  const record = await u.production.withProduction(directory, (_catalog, store) => store.getSynthesisExport(renderId)!);
  const report = JSON.parse(readFileSync(join(directory, record.spec.outputPath + ".quality.json"), "utf8"));
  const sourcePath = join(directory, candidate.body.data.evidence.path);
  writeFileSync(sourcePath, "QA tampered media");
  const tampered = await get("readSegmentVideo", request, true);
  const tamperedAdopt = await post("adoptSegmentVideo", { ...request, expectedAdoptionId: adopted[0]!.body.data.adoption.id, review });
  writeFileSync(sourcePath, media[0]!);
  await u.production.withProduction(directory, catalog => catalog.db.query("UPDATE production_shot SET title = ? WHERE id = ?").run("QA 改镜头后的新方案", project.shotIds[0]!));
  const stale = await post("inspectSegmentVideo", request);
  const afterChange = await get("getVideoTimeline", { projectId: project.projectId, episodeId: project.episodeId });
  const staleRender = await post("runEpisodeRoughCut", project);
  const oldRendered = await get("readEpisodeRoughCut", { projectId: project.projectId, taskId: renderId }, true);
  const invalidProject = await fixture(); const invalidTaskId = await generate(invalidProject, 1);
  const invalid = await post("inspectSegmentVideo", { projectId: invalidProject.projectId, taskId: invalidTaskId });
  const invalidAdopt = await post("adoptSegmentVideo", { projectId: invalidProject.projectId, taskId: invalidTaskId, expectedAdoptionId: null, review });
  const tasks = await u.production.withProduction(directory, (_catalog, store) => store.listProjectTasks(project.projectId));
  writeFileSync(join(root, "result.json"), JSON.stringify({ before, incomplete, candidate, bytesEqual: Buffer.isBuffer(bytes.body) && bytes.body.equals(media[0]!), wrongProject, noReview, conflict,
    adopted, second, timeline, started, renderTask, repeated, report, renderedOk: rendered.status === 200 && rendered.body.length > 1000,
    tampered, tamperedAdopt, stale, afterChange, staleRender, oldRenderedOk: oldRendered.status === 200 && oldRendered.body.equals(rendered.body), invalid, invalidAdopt, calls, tasks }, null, 2));
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}

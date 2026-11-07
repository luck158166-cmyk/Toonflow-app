import { mkdirSync, writeFileSync, readFileSync } from "@toonflow/file";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import express from "../apps/server/node_modules/express";
import { createShotFixture } from "./shotPreparationFixture";
import { listReferenceTargets, listAssetReferences } from "../packages/production/src/assetReference";

const root = process.argv[2]!; if (!root) throw new Error("QA isolated root required");
const ui = process.argv.includes("--ui");
process.env.TOONFLOW_DATA_DIR = join(root, "data"); process.env.NODE_ENV = "dev";
const directory = join(root, "workspace"); mkdirSync(directory, { recursive: true });
const day = 86400000; const originalNow = Date.now; let now = Math.floor(originalNow() / 1000) * 1000; Date.now = () => now;
const startTime = now;
const tiny = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGEkAAAAASUVORK5CYII=", "base64");
const images = new Map<string, Buffer>(); const calls: string[] = []; const bodies: any[] = []; const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("http://127.0.0.1:")) return nativeFetch(input, init);
  const method = init?.method ?? "GET"; calls.push(method + " " + url);
  if (url === "https://ark.cn-beijing.volces.com/api/v3/images/generations" && method === "POST") {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    const [width, height] = body.size.split("x").map(Number);
    const bytes = Buffer.from(await new Bun.Image(tiny).resize(width, height).png().buffer());
    const imageUrl = `https://media.example.test/image${images.size}.png`; images.set(imageUrl, bytes);
    return Response.json({ model: body.model, created: Math.floor(now / 1000), data: [{ url: imageUrl, size: body.size, output_format: "png" }] });
  }
  if (images.has(url)) return new Response(images.get(url)!, { headers: { "content-type": "image/png" } });
  if (url === "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks" && method === "POST") {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    if (body.content.length !== 7 || body.content.some((item: any) => item.type === "image_url" && !item.image_url.url.startsWith("data:image/png;base64,"))) throw new Error("Expected six original reference images");
    return Response.json({ id: "portraitQaVideo" });
  }
  if (url.endsWith("/contents/generations/tasks/portraitQaVideo")) return Response.json({ id: "portraitQaVideo", model: "doubao-seedance-2-5-260628", status: "succeeded", content: { video_url: "https://media.example.test/video.mp4" } });
  if (url === "https://media.example.test/video.mp4") return new Response(Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"));
  throw new Error("QA blocked external request: " + url);
}, nativeFetch);
const { default: initializePlugins } = await import("../apps/server/src/utils/plugins/initialize");
await initializePlugins(join(root, "data/providers"), resolve("packages/providers/src/media"), ["volcengine.ts"]);
const { default: u } = await import("../apps/server/src/utils");
u.conf.set("settings.mediaProviderConfigs.volcengine", { apiKey: "qaPortraitKey" });
const fixture = await u.production.withProduction(directory, (catalog, store) => {
  const fixture = createShotFixture(catalog); store.setBudget(1000000, "CNY");
  for (const [modelId, unit] of [["doubao-seedream-5-0-pro-260628", "seedream5ProSingleImageCeiling"], ["doubao-seedance-2-5-260628", "seedance25NoVideo1080SecondCeiling"]]) {
    store.globalBudgets.recordPriceRule({ provider: "volcengine", modelId: modelId!, unit: unit!, unitSize: 1, unitPriceMicros: 100, currency: "CNY", sourceUrl: "https://example.test/qa", effectiveAt: 1, recordedBy: "qa" });
  }
  return fixture;
});
const app = express(); app.use(express.json());
for (const name of ["previewAssetImage", "runAssetImage", "recoverAssetImage", "adoptAssetImage", "getSegmentPlan", "saveSegmentPlan", "previewSegmentVideo", "reviewSegmentPreflight", "runSegmentVideo", "recoverVideoTask", "readAssetReference", "getAssetReferences"]) app.use("/api/production/" + name, (await import("../apps/server/src/routes/production/" + name + ".ts")).default);
app.use((cause: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(cause.status ?? 500).json({ message: cause.message }));
const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address(); if (!address || typeof address === "string") throw new Error("No address"); const base = "http://127.0.0.1:" + address.port;
const post = async (name: string, body: object) => { const response = await fetch(base + "/api/production/" + name, { method: "POST", headers: { origin: base, "x-toonflow-workspace": "1", "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as any }; };
const ok = (result: { status: number; body: any }) => { if (result.status !== 200) throw new Error(JSON.stringify(result)); return result.body.data; };
const targets = await u.production.withProduction(directory, catalog => listReferenceTargets(catalog, fixture.projectId));
for (const target of targets) for (const role of target.roles) {
  const input = { directory, projectId: fixture.projectId, entityId: target.entityId, entityKind: target.entityKind, role, visualStyle: "写实" };
  const preview = ok(await post("previewAssetImage", input));
  const task = ok(await post("runAssetImage", { ...input, approval: { approved: true, maxCalls: 1, planHash: preview.planHash, maxCostMicros: 1000 } }));
  await u.mediaTasks.wait(directory, task.taskId);
  ok(await post("recoverAssetImage", { directory, projectId: fixture.projectId, taskId: task.taskId }));
  ok(await post("adoptAssetImage", { directory, projectId: fixture.projectId, taskId: task.taskId, rightsConfirmed: true }));
}
const plan = await u.production.withProduction(directory, catalog => u.production.inspectEpisodeSegmentPlan(directory, catalog, fixture.projectId, fixture.episodeId));
const input = { directory, projectId: fixture.projectId, episodeId: fixture.episodeId, sequence: 1, inputHash: plan.inputHash };
ok(await post("saveSegmentPlan", input));
const beforeReview = ok(await post("previewSegmentVideo", input));
ok(await post("reviewSegmentPreflight", { ...input, review: { actionConfirmed: true, continuityConfirmed: true, dialogueConfirmed: true, referencesConfirmed: true, note: "QA only: two declared characters; pixel images do not prove identity" } }));
const ready = ok(await post("previewSegmentVideo", input)); const approval = { approved: true, maxCalls: 1, planHash: ready.planHash, maxCostMicros: 2000 };
u.conf.set("settings.mediaProviderConfigs.volcengine", { apiKey: "qaDifferentAccount" });
const mismatch = ok(await post("previewSegmentVideo", input)); const denied = await post("runSegmentVideo", { ...input, approval });
u.conf.set("settings.mediaProviderConfigs.volcengine", { apiKey: "qaPortraitKey" });
now = startTime + 24 * day; const expiring = ok(await post("previewSegmentVideo", input));
if (ui) {
  app.get("/qa/referenceFixture", async (_req, res) => res.json({ directory, ...fixture,
    episodes: await u.production.withProduction(directory, catalog => catalog.getProjectProduction(fixture.projectId).episodes) }));
  app.use("/api/providers/media/list", (await import("../apps/server/src/routes/providers/media/list")).default);
  app.use("/api/settings/get", (await import("../apps/server/src/routes/settings/get")).default);
  app.use("/api", (_req, res) => res.status(403).json({ message: "QA only" }));
  const { createServer } = await import("../apps/web/node_modules/vite/dist/node/index.js");
  const vite = await createServer({ configFile: resolve("apps/web/vite.config.ts"), root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "mpa" });
  app.use(vite.middlewares); console.log("QA " + base + "/qa/studioPreview.html?stage=portraits " + root);
  process.on("SIGINT", () => { void vite.close().finally(() => process.exit(0)); });
  await new Promise(() => {});
}
now = startTime + 30 * day; const expired = ok(await post("previewSegmentVideo", input)); const expiredRun = await post("runSegmentVideo", { ...input, approval });
const callsBeforeVideo = calls.slice(); now = startTime;

// Stage a reserved capability, then let the portrait expire before its actual fetch. No provider network is allowed.
const { productionSubmissionFetch, withProductionMediaSubmission } = await import("../apps/server/src/utils/production/generationGate");
const guardTask = await u.production.withProduction(directory, (_catalog, store) => {
  const task = store.createHostMediaTask({ projectId: input.projectId, episodeId: input.episodeId, stage: "video", idempotencyKey: "qaDeadline", provider: "volcengine", modelId: "doubao-seedance-2-5-260628", requestJson: ready.requestJson, unit: "seedance25NoVideo1080SecondCeiling", quantity: 10 },
    { workspace: directory, segmentKey: "QA deadline", mediaType: "video", authorization: { approvedRequestHash: createHash("sha256").update(ready.requestJson).digest("hex"), approvedPlanHash: ready.planHash, priceRuleId: ready.price.ruleId, maxCalls: 1, maxCostMicros: 2000, currency: "CNY", providerRevision: ready.modelRevision, credentialScope: ready.credentialScope, segmentInput: { projectId: input.projectId, episodeId: input.episodeId, sequence: 1, inputHash: input.inputHash } } });
  store.claimHostMediaLaunch(task.task.id, directory, "video", ready.requestJson); return task.task;
});
let deadlineError = "";
await withProductionMediaSubmission(directory, guardTask.id, async () => {
  const guardedFetch = productionSubmissionFetch(directory, ready.modelRevision, "qaPortraitKey")!;
  now = startTime + 30 * day;
  try { await guardedFetch("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks", { method: "POST", body: "{}" }); } catch (cause) { deadlineError = String(cause); }
});
await u.production.withProduction(directory, (_catalog, store) => store.markReconciliationRequired(guardTask.id)); now = startTime;
const run = ok(await post("runSegmentVideo", { ...input, approval })); await u.mediaTasks.wait(directory, run.taskId);
const completed = ok(await post("recoverVideoTask", { directory, projectId: input.projectId, taskId: run.taskId }));
const native = await u.mediaTasks.inspect(directory, run.taskId); const videoHash = createHash("sha256").update(readFileSync(join(directory, native!.checkpoint.files![0]!.path))).digest("hex");
now = startTime + 31 * day; u.conf.set("settings.mediaProviderConfigs.volcengine", { apiKey: "qaChangedAfterSuccess" });
const repeat = await post("runSegmentVideo", { ...input, approval });
const references = await u.production.withProduction(directory, catalog => listAssetReferences(catalog, fixture.projectId));
writeFileSync(join(root, "result.json"), JSON.stringify({ beforeReview, ready, mismatch, denied, expiring, expired, expiredRun, callsBeforeVideo, deadlineError, completed, repeat, run, videoHash, references, calls, bodies }));
Date.now = originalNow; server.close(); process.exit(0);

import { mkdirSync, writeFileSync, readFileSync } from "@toonflow/file";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createShotFixture } from "./shotPreparationFixture";
import { listReferenceTargets, listAssetReferences } from "../packages/production/src/assetReference";
import express from "../apps/server/node_modules/express";

const root = process.argv[2]!; if (!root) throw new Error("QA isolated directory required");
const ui = process.argv.includes("--ui");
process.env.TOONFLOW_DATA_DIR = join(root, "data"); process.env.NODE_ENV = "dev";
const directory = join(root, "workspace"); mkdirSync(directory, { recursive: true });
const tiny = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGEkAAAAASUVORK5CYII=", "base64");
const bytes = Buffer.from(await new Bun.Image(tiny).resize(1024, 1024).png().buffer());
const calls: string[] = []; const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("http://127.0.0.1:")) return nativeFetch(input, init);
  const method = init?.method ?? "GET"; calls.push(method + " " + url);
  if (url === "https://ark.cn-beijing.volces.com/api/v3/images/generations" && method === "POST") {
    const body = JSON.parse(String(init?.body));
    if (body.size !== "1024x1024" || body.watermark !== false || body.image) throw new Error("unexpected image request");
    return Response.json({ model: body.model, created: Math.floor(Date.now() / 1000), data: [{ url: "https://media.example.test/asset.png", size: body.size, output_format: "png" }], usage: { generated_images: 1 } });
  }
  if (url === "https://media.example.test/asset.png") return new Response(bytes, { headers: { "content-type": "image/png" } });
  throw new Error("QA blocked external request: " + url);
}, nativeFetch);
const { default: initializePlugins } = await import("../apps/server/src/utils/plugins/initialize");
await initializePlugins(join(root, "data/providers"), resolve("packages/providers/src/media"), ["volcengine.ts"]);
const { default: u } = await import("../apps/server/src/utils");
u.conf.set("settings.mediaProviderConfigs.volcengine", { apiKey: "qaNeverRealKey" });
const fixture = await u.production.withProduction(directory, (catalog, store) => {
  const fixture = createShotFixture(catalog); const target = listReferenceTargets(catalog, fixture.projectId).find(item => item.kind === "character")!;
  store.setBudget(100000, "CNY");
  store.globalBudgets.recordPriceRule({ provider: "volcengine", modelId: "doubao-seedream-5-0-pro-260628", unit: "seedream5ProSingleImageCeiling",
    unitSize: 1, unitPriceMicros: 100, currency: "CNY", sourceUrl: "https://example.test/qa", effectiveAt: 1, recordedBy: "qa" });
  return { ...fixture, target };
});
const app = express(); app.use(express.json());
for (const name of ["previewAssetImage", "runAssetImage", "recoverAssetImage", "readAssetImage", "adoptAssetImage", "getAssetReferences", "readAssetReference"]) app.use("/api/production/" + name, (await import("../apps/server/src/routes/production/" + name + ".ts")).default);
if (ui) {
  app.get("/qa/referenceFixture", (_req, res) => res.json({ directory, projectId: fixture.projectId }));
  app.use("/api/providers/media/list", (await import("../apps/server/src/routes/providers/media/list")).default);
  app.use("/api/settings/get", (await import("../apps/server/src/routes/settings/get")).default);
  app.use("/api", (_req, res) => res.status(403).json({ message: "QA only" }));
  const { createServer } = await import("../apps/web/node_modules/vite/dist/node/index.js");
  const vite = await createServer({ configFile: resolve("apps/web/vite.config.ts"), root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "mpa" });
  app.use(vite.middlewares);
  const previewServer = app.listen(0, "127.0.0.1", () => {
    const address = previewServer.address();
    if (address && typeof address !== "string") console.log(`QA http://127.0.0.1:${address.port}/qa/studioPreview.html?stage=references ${root}`);
  });
  process.on("SIGINT", () => { void vite.close().finally(() => process.exit(0)); });
  await new Promise(() => {});
}
app.use((cause: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(cause.status ?? 500).json({ message: cause.message }));
const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address(); if (!address || typeof address === "string") throw new Error("No address");
const base = "http://127.0.0.1:" + address.port;
const post = async (name: string, body: object) => { const response = await fetch(base + "/api/production/" + name, { method: "POST", headers: { origin: base, "x-toonflow-workspace": "1", "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as any }; };
const input = { directory, projectId: fixture.projectId, entityKind: fixture.target.entityKind, entityId: fixture.target.entityId, role: "headshot", visualStyle: "写实" };
const initial = await post("previewAssetImage", input);
const approval = { approved: true, maxCalls: 1, planHash: initial.body.data.planHash, maxCostMicros: 1000 };
u.conf.set("settings.mediaProviderConfigs.volcengine", { apiKey: "qaChangedKey" });
const stale = await post("runAssetImage", { ...input, approval });
u.conf.set("settings.mediaProviderConfigs.volcengine", { apiKey: "qaNeverRealKey" });
const before = calls.slice();
const runs = await Promise.all([post("runAssetImage", { ...input, approval }), post("runAssetImage", { ...input, approval })]);
const taskId = runs[0]!.body.data?.taskId; if (!taskId) throw new Error(JSON.stringify(runs));
await u.mediaTasks.wait(directory, taskId);
const taskInput = { directory, projectId: fixture.projectId, taskId };
const recovered = await post("recoverAssetImage", taskInput);
const notConfirmed = await post("adoptAssetImage", { ...taskInput, rightsConfirmed: false });
const adopted = await post("adoptAssetImage", { ...taskInput, rightsConfirmed: true });
const duplicate = await post("adoptAssetImage", { ...taskInput, rightsConfirmed: true });
const repeat = await post("runAssetImage", { ...input, approval });
const source = await u.mediaTasks.inspect(directory, taskId); const path = source!.checkpoint.files![0]!.path;
const adoptedFile = adopted.body.data?.reference; if (!adoptedFile) throw new Error(JSON.stringify(adopted));
const preserved = createHash("sha256").update(readFileSync(join(directory, adoptedFile.path))).digest("hex") === createHash("sha256").update(bytes).digest("hex");
const { withProductionMediaSubmission, assertProductionProviderRevision } = await import("../apps/server/src/utils/production/generationGate");
const binding = await u.production.withProduction(directory, (_catalog, store) => store.getHostMediaBinding(taskId)!);
let scopeError = "";
await withProductionMediaSubmission(directory, taskId, async () => { try { await assertProductionProviderRevision(directory, binding.authorization.providerRevision!, "changedKey"); } catch (cause) { scopeError = String(cause); } });
writeFileSync(join(directory, path), Buffer.from("modified"));
const tampered = await post("adoptAssetImage", { ...taskInput, rightsConfirmed: true });
writeFileSync(join(directory, path), bytes);
const other = await u.production.withProduction(directory, catalog => catalog.importStory({ title: "other", sourceKind: "synopsis", sourceText: "other" }));
const crossProject = await post("adoptAssetImage", { ...taskInput, projectId: other, rightsConfirmed: true });
const state = await u.production.withProduction(directory, (catalog, store) => ({ references: listAssetReferences(catalog, fixture.projectId), tasks: store.listProjectTasks(fixture.projectId), usage: store.getBudgetUsage() }));
writeFileSync(join(root, "result.json"), JSON.stringify({ initial, stale, before, runs, recovered, notConfirmed, adopted, duplicate, repeat, preserved, scopeError, tampered, crossProject, calls, ...state }));
server.close(); process.exit(0);

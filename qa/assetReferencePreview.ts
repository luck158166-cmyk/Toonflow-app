import { mkdtempSync, mkdirSync, writeFileSync } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "../apps/server/node_modules/express";
import { createHash } from "node:crypto";
import { createShotFixture, bindFixtureImages } from "./shotPreparationFixture";

// Isolated local UI verification with real production and workspace-file routes.
const root = mkdtempSync(join(tmpdir(), "assetReferencePreview"));
const directory = join(root, "workspace"); mkdirSync(directory);
process.env.TOONFLOW_DATA_DIR = join(root, "data");
process.env.NODE_ENV = "dev";
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("http://127.0.0.1:")) throw new Error("QA blocked external network");
  return originalFetch(input, init);
}, originalFetch);
const { default: u } = await import("../apps/server/src/utils");
const preparationMode = process.argv.includes("--shots");
const imagePath = join(root, "qaPixel.png");
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGEkAAAAASUVORK5CYII=", "base64");
writeFileSync(imagePath, bytes); writeFileSync(join(directory, "input.png"), bytes);
let shots: Array<{ id: string; episodeNumber: number; sequence: number; title: string }> = [];
const projectId = await u.production.withProduction(directory, async catalog => {
  if (preparationMode) {
    const fixture = createShotFixture(catalog);
    const file = await u.production.preserveReferenceImage(directory, "input.png", createHash("sha256").update(bytes).digest("hex"));
    bindFixtureImages(catalog, fixture.projectId, file);
    shots = catalog.getProjectProduction(fixture.projectId).shots;
    return fixture.projectId;
  }
  const projectId = catalog.importStory({ title: "参考图界面验证", sourceKind: "synopsis", sourceText: "林岚在车站拾起钥匙。" });
  const id = catalog.upsertAsset({ projectId, name: "林岚（验证人物）", kind: "character", stableDescription: "黑发、蓝色外套；仅用于界面验证。", evidence: [] });
  catalog.setAssetLocked(id, true);
  catalog.upsertAsset({ projectId, name: "钥匙（尚未审核）", kind: "prop", stableDescription: "铜钥匙", evidence: [] });
  return projectId;
});
const app = express();
app.use(express.json()); app.use(express.raw({ type: "application/octet-stream", limit: "21mb" }));
app.get("/qa/referenceFixture", (_req, res) => res.json({ directory, projectId, ...(preparationMode ? { shots } : {}) }));
app.use("/api", (req, res, next) => {
  if ((req.query.directory ?? req.body?.directory) !== directory) return res.status(403).json({ message: "QA workspace only" });
  next();
});
for (const name of ["getAssetReferences", "bindAssetReference", "readAssetReference", "getShotPreparation", "saveShotPreparation"]) {
  app.use(`/api/production/${name}`, (await import(`../apps/server/src/routes/production/${name}.ts`)).default);
}
for (const name of ["list", "mkdir", "write"]) {
  app.use(`/api/workspaces/files/${name}`, (await import(`../apps/server/src/routes/workspaces/files/${name}.ts`)).default);
}
app.use("/api", (_req, res) => res.status(404).json({ message: "QA route unavailable" }));
app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ message: error.message }));
const { createServer } = await import("../apps/web/node_modules/vite/dist/node/index.js");
const vite = await createServer({ configFile: resolve("apps/web/vite.config.ts"), root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "mpa" });
app.use(vite.middlewares);
const server = app.listen(5198, "127.0.0.1", () => console.log(JSON.stringify({ url: `http://127.0.0.1:5198/qa/studioPreview.html?stage=${preparationMode ? "preparation" : "references"}`, directory, projectId, imagePath })));
process.on("SIGINT", async () => { await vite.close(); server.close(() => process.exit(0)); });

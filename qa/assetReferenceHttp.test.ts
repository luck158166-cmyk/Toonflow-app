import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import express from "../apps/server/node_modules/express";
import { listAssetReferences } from "../packages/production/src/assetReference";
import { createShotFixture, bindFixtureImages } from "./shotPreparationFixture";

it("binds and reads preserved image bytes through actual local routes, rejects tampering, and backs up references", async () => {
  const root = mkdtempSync(join(tmpdir(), "assetReferenceHttp"));
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const oldData = process.env.TOONFLOW_DATA_DIR; const oldEnv = process.env.NODE_ENV;
  process.env.TOONFLOW_DATA_DIR = root; process.env.NODE_ENV = "dev";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("http://127.0.0.1:")) throw new Error("QA blocked external network");
    return originalFetch(input, init);
  }, originalFetch);
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    const { default: u } = await import("../apps/server/src/utils");
    const { default: listRoute } = await import("../apps/server/src/routes/production/getAssetReferences");
    const { default: bindRoute } = await import("../apps/server/src/routes/production/bindAssetReference");
    const { default: readRoute } = await import("../apps/server/src/routes/production/readAssetReference");
    const app = express(); app.use(express.json());
    app.use("/list", listRoute); app.use("/bind", bindRoute); app.use("/read", readRoute);
    app.use("/preparation", (await import("../apps/server/src/routes/production/getShotPreparation")).default);
    app.use("/savePreparation", (await import("../apps/server/src/routes/production/saveShotPreparation")).default);
    app.use("/prompt", (await import("../apps/server/src/routes/production/getShotPrompt")).default);
    app.use("/savePrompt", (await import("../apps/server/src/routes/production/saveShotPrompt")).default);
    app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ message: error.message }));
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server!.once("listening", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing port");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { origin: base, "x-toonflow-workspace": "1", "content-type": "application/json" };
    const post = (body: object, origin = base) => fetch(base + "/bind", { method: "POST", headers: { ...headers, origin }, body: JSON.stringify(body) });
    const projectId = await u.production.withProduction(workspace, catalog => {
      const projectId = catalog.importStory({ title: "参考图", sourceKind: "synopsis", sourceText: "林岚在车站。" });
      const id = catalog.upsertAsset({ projectId, name: "林岚", kind: "character", stableDescription: "黑发", evidence: [] });
      catalog.setAssetLocked(id, true); return projectId;
    });
    const query = new URLSearchParams({ directory: workspace, projectId });
    const listed = await (await fetch(base + "/list?" + query, { headers })).json();
    const target = listed.data.targets[0];
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGEkAAAAASUVORK5CYII=", "base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(workspace, "input.png"), bytes);
    const input = { directory: workspace, projectId, entityKind: "asset", entityId: target.entityId,
      entityHash: target.entityHash, role: "headshot", expectedReferenceId: null, rightsConfirmed: true,
      sourceNote: "QA 测试图，非生产素材", path: "input.png", sha256 };
    expect((await post(input, "https://untrusted.example.test")).status).toBe(403);
    expect((await post({ ...input, rightsConfirmed: false })).status).toBe(400);
    expect((await post({ ...input, path: "../input.png" })).status).toBe(409);
    expect((await post({ ...input, sha256: "a".repeat(64) })).status).toBe(409);
    const accepted = await post(input); expect(accepted.status).toBe(200);
    const first = (await accepted.json()).data.reference;
    expect(first).toMatchObject({ version: 1, width: 1, height: 1, mimeType: "image/png", sha256 });
    expect(readFileSync(join(workspace, first.path))).toEqual(bytes);
    expect((await (await post(input)).json()).data.created).toBe(false);
    writeFileSync(join(workspace, "input.png"), "changed original");
    const readQuery = new URLSearchParams({ directory: workspace, projectId, referenceId: first.id });
    const read = await fetch(base + "/read?" + readQuery, { headers }); expect(read.status).toBe(200);
    expect(Buffer.from(await read.arrayBuffer())).toEqual(bytes);
    const simultaneousReads = await Promise.all(Array.from({ length: 8 }, () => fetch(base + "/read?" + readQuery, { headers })));
    expect(simultaneousReads.map(response => response.status)).toEqual(Array(8).fill(200));
    for (const response of simultaneousReads) expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    readQuery.set("projectId", crypto.randomUUID());
    expect((await fetch(base + "/read?" + readQuery, { headers })).status).toBe(404);
    const fixture = await u.production.withProduction(workspace, catalog => {
      const fixture = createShotFixture(catalog); bindFixtureImages(catalog, fixture.projectId, first); return fixture;
    });
    const preparationQuery = new URLSearchParams({ directory: workspace, projectId: fixture.projectId, shotId: fixture.shotIds[0]! });
    const preparedResponse = await fetch(base + "/preparation?" + preparationQuery, { headers });
    expect(preparedResponse.status).toBe(200);
    const prepared = (await preparedResponse.json()).data;
    expect(prepared.issues).toEqual([]); expect(prepared.snapshot.references).toHaveLength(6);
    const saveInput = { directory: workspace, projectId: fixture.projectId, shotId: fixture.shotIds[0], inputHash: prepared.inputHash };
    const save = (input = saveInput, origin = base) => fetch(base + "/savePreparation", {
      method: "POST", headers: { ...headers, origin }, body: JSON.stringify(input) });
    expect((await save(saveInput, "https://untrusted.example.test")).status).toBe(403);
    expect((await save({ ...saveInput, projectId })).status).toBe(409);
    expect((await save({ ...saveInput, inputHash: "a".repeat(64) })).status).toBe(409);
    const savedResponse = await save(); expect(savedResponse.status).toBe(200);
    const saved = (await savedResponse.json()).data;
    expect(saved.version).toBe(1);
    expect((await (await save()).json()).data).toEqual({ ...saved, created: false });
    const promptResponse = await fetch(base + "/prompt?" + preparationQuery, { headers });
    expect(promptResponse.status).toBe(200);
    const compiled = (await promptResponse.json()).data;
    expect(compiled.canSave).toBe(true); expect(compiled.readyForGeneration).toBe(false);
    const promptInput = { ...saveInput, inputHash: compiled.inputHash };
    const savePrompt = (input = promptInput, origin = base) => fetch(base + "/savePrompt", {
      method: "POST", headers: { ...headers, origin }, body: JSON.stringify(input) });
    expect((await savePrompt(promptInput, "https://untrusted.example.test")).status).toBe(403);
    expect((await savePrompt({ ...promptInput, projectId })).status).toBe(409);
    expect((await savePrompt({ ...promptInput, inputHash: "f".repeat(64) })).status).toBe(409);
    const promptSavedResponse = await savePrompt(); expect(promptSavedResponse.status).toBe(200);
    const promptSaved = (await promptSavedResponse.json()).data;
    expect(promptSaved.version).toBe(1);
    expect((await (await savePrompt()).json()).data).toEqual({ ...promptSaved, created: false });
    expect(await u.production.withProduction(workspace, (_catalog, store) => store.listProjectTasks(fixture.projectId))).toEqual([]);
    const archive = unzipSync(await u.production.createProjectBackup(workspace, root));
    expect(archive["workspace/" + first.path]).toEqual(new Uint8Array(bytes));
    const snapshot = new Database(archive["workspace/.production/production.db"]!);
    try {
      expect(snapshot.query("SELECT sha256 FROM asset_reference WHERE id = ?").get(first.id)).toEqual({ sha256 });
      const manifest = snapshot.query("SELECT snapshot_json AS content FROM shot_preparation WHERE id = ?").get(saved.id) as { content: string };
      expect(JSON.parse(manifest.content)).toEqual(prepared.snapshot);
      const promptManifest = snapshot.query("SELECT snapshot_json AS content FROM compiled_shot_prompt WHERE id = ?").get(promptSaved.id) as { content: string };
      expect(JSON.parse(promptManifest.content)).toEqual(compiled.snapshot);
    }
    finally { snapshot.close(); }
    writeFileSync(join(workspace, first.path), "tampered preserved file");
    readQuery.set("projectId", projectId);
    expect((await fetch(base + "/read?" + readQuery, { headers })).status).toBe(409);
    const broken = (await (await fetch(base + "/preparation?" + preparationQuery, { headers })).json()).data;
    expect(broken.issues.some((item: { code: string }) => item.code === "referenceBytes")).toBe(true);
    expect((await save()).status).toBe(409);
    const brokenPrompt = (await (await fetch(base + "/prompt?" + preparationQuery, { headers })).json()).data;
    expect(brokenPrompt.canSave).toBe(false); expect(brokenPrompt.fileIssues).toHaveLength(6);
    expect((await savePrompt()).status).toBe(409);
    writeFileSync(join(workspace, "input.png"), bytes);
    expect((await post(input)).status).toBe(409);
    const references = await u.production.withProduction(workspace, catalog => listAssetReferences(catalog, projectId));
    expect(references).toHaveLength(1);
  } finally {
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    globalThis.fetch = originalFetch;
    if (oldData === undefined) delete process.env.TOONFLOW_DATA_DIR; else process.env.TOONFLOW_DATA_DIR = oldData;
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

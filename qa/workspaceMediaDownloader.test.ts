import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, symlinkSync } from "@toonflow/file";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { WorkspaceMediaDownloader } from "../packages/production/src/workspaceMediaDownloader";
import { Database } from "bun:sqlite";
import { ProductionStore } from "../packages/production/src/store";
import { processPendingMediaDownloads } from "../packages/production/src/mediaDownloadWorker";

async function workspace(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "toonflow-download-"));
  try { await run(root); }
  finally {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe QA cleanup path.");
    rmSync(root, { recursive: true, force: true });
  }
}

it("publishes streamed bytes and adopts the completed file after a process restart without network", async () => workspace(async root => {
  const bytes = new TextEncoder().encode("mock video bytes");
  const expected = createHash("sha256").update(bytes).digest("hex");
  const port = new WorkspaceMediaDownloader(root, { fetchMedia: async () => new Response(bytes) });
  expect(await port.download("https://media.example.test/clip", "assets/clip.mp4")).toEqual({ sha256: expected });
  expect(readFileSync(join(root, "assets/clip.mp4"))).toEqual(Buffer.from(bytes));
  let calls = 0;
  const restarted = new WorkspaceMediaDownloader(root, { fetchMedia: async () => { calls++; throw new Error("offline"); } });
  expect(await restarted.download("https://media.example.test/clip", "assets/clip.mp4")).toEqual({ sha256: expected });
  expect(calls).toBe(0);
  writeFileSync(join(root, "assets/clip.mp4"), "changed");
  await expect(restarted.download("https://media.example.test/clip", "assets/clip.mp4")).rejects.toThrow("cannot be replaced");
  expect(readFileSync(join(root, "assets/clip.mp4"), "utf8")).toBe("changed");
}));

it("cleans an interrupted partial download and retries only the media fetch", async () => workspace(async root => {
  let failed = true;
  const port = new WorkspaceMediaDownloader(root, { fetchMedia: async () => {
    if (!failed) return new Response("whole clip");
    let reads = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode("partial"));
      else controller.error(new Error("connection lost"));
    } }));
  } });
  await expect(port.download("https://media.example.test/clip", "clip.mp4")).rejects.toThrow("connection lost");
  expect(existsSync(join(root, "clip.mp4"))).toBe(false);
  expect(readdirSync(root)).toEqual([]);
  failed = false;
  await port.download("https://media.example.test/clip", "clip.mp4");
  expect(readFileSync(join(root, "clip.mp4"), "utf8")).toBe("whole clip");
}));

it("rejects existing files, traversal and directory junctions before making network requests", async () => workspace(async root => {
  let calls = 0;
  const port = new WorkspaceMediaDownloader(root, { fetchMedia: async () => { calls++; return new Response("new"); } });
  writeFileSync(join(root, "owned.mp4"), "keep");
  await expect(port.download("https://media.example.test/clip", "owned.mp4")).rejects.toThrow("cannot be replaced");
  await expect(port.download("https://media.example.test/clip", "../outside.mp4")).rejects.toThrow("workspace relative");
  mkdirSync(join(root, "real"));
  symlinkSync(join(root, "real"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  await expect(port.download("https://media.example.test/clip", "alias/clip.mp4")).rejects.toThrow("ordinary directory");
  expect(calls).toBe(0);
  expect(readFileSync(join(root, "owned.mp4"), "utf8")).toBe("keep");
}));

it("rejects oversized and partial HTTP responses without publishing an artifact", async () => workspace(async root => {
  const oversized = new WorkspaceMediaDownloader(root, { maxBytes: 3, fetchMedia: async () => new Response("four") });
  await expect(oversized.download("https://media.example.test/clip", "large.mp4")).rejects.toThrow("byte limit");
  const partial = new WorkspaceMediaDownloader(root, { fetchMedia: async () => new Response("part", { status: 206 }) });
  await expect(partial.download("https://media.example.test/clip", "partial.mp4")).rejects.toThrow("HTTP 206");
  expect(readdirSync(root)).toEqual([]);
}));

it("recovers a published file after reopening SQLite without fetching or generating again", async () => workspace(async root => {
  const databasePath = join(root, "production.db");
  let db = new Database(databasePath);
  try {
    let store = new ProductionStore(db);
    store.setBudget(1000, "CNY");
    const task = store.createTask({ idempotencyKey: "crash-download", projectId: "p", episodeId: "e",
      stage: "video", provider: "mock", requestJson: "{}", estimatedCostMicros: 100, currency: "CNY", billable: true }).task;
    store.beginSubmission(task.id);
    store.registerProviderTask(task.id, "remote-1");
    store.enqueueMediaDownload(task.id, "primary", "https://media.example.test/clip", "assets/recovered.mp4", Date.now() + 86_400_000);
    const [pending] = store.claimDueMediaDownloads();
    const initial = new WorkspaceMediaDownloader(root, { fetchMedia: async () => new Response("complete video") });
    await initial.download(pending.remoteUrl, pending.destinationPath);
    db.close(); // Simulate exit between durable file publication and database completion.
    db = new Database(databasePath);
    store = new ProductionStore(db);
    expect(store.recoverInterruptedMediaDownloads().recovered).toBe(1);
    let fetches = 0;
    const resumed = new WorkspaceMediaDownloader(root, { fetchMedia: async () => { fetches++; throw new Error("offline"); } });
    expect(await processPendingMediaDownloads(store, resumed)).toMatchObject({ downloaded: 1, retrying: 0 });
    expect(fetches).toBe(0);
    expect(store.getTask(task.id)).toMatchObject({ state: "succeeded", attempt: 1, providerTaskId: "remote-1" });
    expect(store.getBudgetUsage("CNY").reservedMicros).toBe(100);
  } finally { db.close(); }
}));

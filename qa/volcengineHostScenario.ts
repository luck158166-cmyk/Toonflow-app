import { mkdirSync, readFileSync, writeFileSync } from "@toonflow/file";
import { join, resolve } from "node:path";
import express from "../apps/server/node_modules/express";

const [root, phase] = process.argv.slice(2);
if (!root || !phase) throw new Error("Missing isolated QA directory/phase");
process.env.TOONFLOW_DATA_DIR = join(root, "data");
process.env.NODE_ENV = "dev";
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });
const originalFetch = globalThis.fetch;
const calls: string[] = [];
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
  const method = init?.method ?? "GET";
  calls.push(`${method} ${url}`);
  if (url === "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks" && method === "POST") {
    if (phase === "unknown") throw new Error("QA unknown submission: connection lost");
    if (phase !== "submit" && phase !== "crash") throw new Error("QA duplicate submission forbidden");
    const body = JSON.parse(String(init?.body));
    if (body.content[1]?.image_url?.url !== `data:image/png;base64,${readFileSync(join(workspace, "reference.png")).toString("base64")}`) throw new Error("QA original bytes changed");
    return Response.json({ id: "arkHostQa" });
  }
  if (url === "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/arkHostQa" && method === "GET") {
    if (phase === "crash") {
      writeFileSync(join(root, "resultcrash.json"), JSON.stringify({ calls }));
      process.exit(0); // 接单 checkpoint 已落盘，宿主尚未写终态，模拟进程直接退出。
    }
    if (phase === "submit") throw new Error("QA interrupted after persisted receipt");
    return Response.json({ id: "arkHostQa", model: "doubao-seedance-2-5-260628", status: "succeeded",
      content: { video_url: "https://media.example.test/qa.mp4" }, created_at: 1800000000,
      usage: { completion_tokens: 17, total_tokens: 17 } });
  }
  if (url === "https://media.example.test/qa.mp4") {
    // 仅验证宿主持久化，不是可播放成片或视频质量证据。
    return new Response(Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"), { headers: { "content-type": "video/mp4" } });
  }
  throw new Error("QA blocked external network: " + url);
}, originalFetch);

const { default: initializePlugins } = await import("../apps/server/src/utils/plugins/initialize");
await initializePlugins(join(root, "data/providers"), resolve("packages/providers/src/media"), ["volcengine.ts"]);
const { default: u } = await import("../apps/server/src/utils");
u.conf.set("settings.mediaProviderConfigs.volcengine", { apiKey: "qaHostKeyNeverSend" });
if (phase === "submit" || phase === "crash") {
  const tiny = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGEkAAAAASUVORK5CYII=", "base64");
  writeFileSync(join(workspace, "reference.png"), await new Bun.Image(tiny).resize(320, 320).png().buffer());
}
if (phase === "gate") await u.production.withProduction(workspace, catalog => catalog.importStory({ title: "QA 生产保护", sourceKind: "synopsis", sourceText: "雨中的车站。" }));
const app = express(); app.use(express.json());
app.use("/generate", (await import("../apps/server/src/routes/ai/media/generate")).default);
app.use("/status", (await import("../apps/server/src/routes/ai/media/tasks/status")).default);
app.use("/models", (await import("../apps/server/src/routes/ai/media/models")).default);
app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ message: error.message }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing port");
const base = `http://127.0.0.1:${address.port}`;
const headers = { origin: base, "x-toonflow-workspace": "1", "content-type": "application/json" };
const id = phase === "unknown" || phase === "unknownResume" ? "11111111-1111-4111-8111-111111111112"
  : phase === "gate" ? "11111111-1111-4111-8111-111111111113" : "11111111-1111-4111-8111-111111111111";
const input = { directory: workspace, mediaType: "video", taskId: id, providerId: "volcengine", modelId: "doubao-seedance-2-5-260628",
  prompt: "{{ref 1}} 中的港口，清晨缓慢推进", images: [{ path: "reference.png", mimeType: "image/png" }],
  referenceOrder: [{ type: "image", index: 0 }], duration: 5, resolution: "720p", ratio: "9:16", mode: ["imageReference:30"] };
const models = await (await fetch(base + "/models")).json();
let submissionStatus: number | undefined;
let duplicateStatus: number | undefined;
let failure: string | undefined;
if (phase !== "resume" && phase !== "unknownResume") {
  const send = () => fetch(base + "/generate", { method: "POST", headers, body: JSON.stringify(input) });
  const [response, duplicate] = await Promise.all([send(), ...(phase === "submit" ? [send()] : [])]);
  duplicateStatus = duplicate?.status;
  submissionStatus = response.status;
  if (!response.ok) failure = (await response.json()).message;
} else {
  await fetch(base + "/status", { method: "POST", headers, body: JSON.stringify({ directory: workspace, taskIds: [id], resume: true }) });
}
if (phase !== "gate") {
  try { await u.mediaTasks.wait(workspace, id); } catch (error) { failure = String(error); }
}
const snapshot = (await (await fetch(base + "/status", { method: "POST", headers,
  body: JSON.stringify({ directory: workspace, taskIds: [id] }) })).json()).data[0];
writeFileSync(join(root, `result${phase}.json`), JSON.stringify({ models: models.data, calls, submissionStatus, duplicateStatus, failure, snapshot }, null, 2));
server.close();
process.exit(0);

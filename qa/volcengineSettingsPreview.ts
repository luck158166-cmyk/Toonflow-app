import { mkdtempSync } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "../apps/server/node_modules/express";

const root = mkdtempSync(join(tmpdir(), "arkSettingsPreview"));
process.env.TOONFLOW_DATA_DIR = root; process.env.NODE_ENV = "dev";
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("http://127.0.0.1:")) throw new Error("QA blocked external network");
  return originalFetch(input, init);
}, originalFetch);
const { default: initializePlugins } = await import("../apps/server/src/utils/plugins/initialize");
await initializePlugins(join(root, "providers"), resolve("packages/providers/src/media"), ["volcengine.ts"]);
const app = express();
app.use("/api/providers/media/list", (await import("../apps/server/src/routes/providers/media/list")).default);
app.use("/api/settings/get", (await import("../apps/server/src/routes/settings/get")).default);
app.use("/api", (_req, res) => res.status(403).json({ message: "QA 只读预览，禁用其他接口" }));
const { createServer } = await import("../apps/web/node_modules/vite/dist/node/index.js");
const vite = await createServer({ configFile: resolve("apps/web/vite.config.ts"), root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "mpa" });
app.use(vite.middlewares);
const server = app.listen(5198, "127.0.0.1", () => console.log("QA http://127.0.0.1:5198/qa/studioPreview.html?stage=models · " + root));
process.on("SIGINT", () => { server.close(); void vite.close().finally(() => process.exit(0)); });

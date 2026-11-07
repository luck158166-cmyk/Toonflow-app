import { expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "../apps/server/node_modules/express";

it("uses actual HTTP routes and the host SDK with an intercepted wire, including one-call failure handling", async () => {
  const root = mkdtempSync(join(tmpdir(), "toonflowAdaptationHttp"));
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const oldData = process.env.TOONFLOW_DATA_DIR; const oldEnv = process.env.NODE_ENV;
  process.env.TOONFLOW_DATA_DIR = root; process.env.NODE_ENV = "dev";
  writeFileSync(join(root, "settings.json"), JSON.stringify({ settings: { customProviders: [{ id: "qa-provider", label: "QA",
    apiUrl: "https://model.example.test/v1", apiKey: "qa-not-a-real-key", protocol: "openai-completions",
    models: [{ id: "qa-text", label: "QA text", contextWindow: 65536, maxOutputTokens: 16384 }] }] } }));
  const originalFetch = globalThis.fetch;
  let modelCalls = 0; let failProvider = false; let draft: object = {};
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
    if (url !== "https://model.example.test/v1/chat/completions") throw new Error(`QA blocked external network: ${url}`);
    modelCalls++;
    const payload = JSON.parse(String(init?.body));
    expect(payload.max_tokens ?? payload.max_completion_tokens).toBe(8192);
    expect(init?.redirect).toBe("error");
    if (failProvider) return new Response(JSON.stringify({ error: { message: "QA failure", type: "server_error" } }), { status: 500, headers: { "content-type": "application/json" } });
    const chunk = { id: "qa-response", object: "chat.completion.chunk", created: 1, model: "qa-text" };
    return new Response(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(draft) }, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 } })}\n\n`
      + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }, originalFetch);
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    const { default: u } = await import("../apps/server/src/utils");
    const { default: prepareRoute } = await import("../apps/server/src/routes/production/prepareAdaptation");
    const { default: previewRoute } = await import("../apps/server/src/routes/production/previewAdaptation");
    const { default: runRoute } = await import("../apps/server/src/routes/production/runAdaptation");
    const { default: reviewDataRoute } = await import("../apps/server/src/routes/production/getEpisodeReview");
    const { default: reviewRoute } = await import("../apps/server/src/routes/production/reviewEpisode");
    const app = express(); app.use(express.json({ limit: "2mb" }));
    app.use("/prepare", prepareRoute); app.use("/preview", previewRoute); app.use("/run", runRoute);
    app.use("/reviewData", reviewDataRoute); app.use("/review", reviewRoute);
    app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ message: error.message }));
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server!.once("listening", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test port");
    const base = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body: object, origin = base) => fetch(base + path, { method: "POST",
      headers: { "content-type": "application/json", origin, "x-toonflow-workspace": "1" }, body: JSON.stringify(body) });
    for (const mode of ["success", "failure"]) {
      const projectId = await u.production.withProduction(workspace, (catalog, store) => {
        store.setBudget(1_000_000, "CNY");
        store.globalBudgets.recordPriceRule({ provider: "qa-provider", modelId: "qa-text", unit: "textTokenCeiling", unitSize: 1,
          unitPriceMicros: 1, currency: "CNY", sourceUrl: "https://example.test/price", effectiveAt: 1, recordedBy: "qa" });
        return catalog.importStory({ title: "雨夜", sourceKind: "novel", sourceText: "第一章 雨夜\n" + "林岚走进车站。".repeat(20) });
      });
      const prepared = await (await post("/prepare", { directory: workspace, projectId, options: { episodeNumber: 1,
        firstChapter: 1, lastChapter: 1, targetSeconds: 5, genre: "悬疑", visualStyle: "动画" } })).json();
      const evidence = [{ sourceHash: prepared.data.sourceHash, chapterSequence: 1, lineStart: 2, lineEnd: 2, quote: "林岚走进车站。" }];
      draft = { episodeNumber: 1, title: "雨夜", logline: "进入车站", outline: ["进入车站"],
        script: [{ location: "车站", characters: ["林岚"], evidence, beats: [{ type: "action", text: "林岚走进车站" }] }],
        characters: [{ name: "林岚", aliases: [], stableDescription: "黑发女子", firstAppearance: "第一章", evidence }],
        scenes: [{ name: "车站", location: "车站", atmosphere: "寂静", timeWeather: "夜", evidence }],
        shots: [{ sequence: 1, sceneName: "车站", title: "进入车站", scriptExcerpt: "林岚走进车站", evidence,
          durationMs: 5000, shotSize: "近景", movement: "固定", promptText: "", characterNames: ["林岚"], dialogue: [],
          direction: { summary: "林岚走进车站", action: "林岚走过门口，停下脚步", camera: "固定",
            positions: [{ name: "林岚", start: "在左侧门口面向候车厅", end: "在画面中央看向前方" }],
            environment: "夜间车站灯光昏黄", style: "动画", sound: "脚步声" },
          sceneContext: { sceneSequence: 1, isolate: false, reason: "" } }] };
      const input = { directory: workspace, projectId, inputId: prepared.data.id, providerId: "qa-provider", modelId: "qa-text", maxOutputTokens: 8192 };
      const before = modelCalls;
      expect((await post("/preview", input, "https://untrusted.example.test")).status).toBe(403);
      const preview = await post("/preview", input); expect(preview.status).toBe(200);
      const plan = (await preview.json()).data; expect(modelCalls).toBe(before);
      const approval = { approved: true, maxCalls: 1, planHash: plan.planHash, maxCostMicros: plan.estimatedCostMicros };
      expect((await post("/run", { ...input, approval: { ...approval, approved: false } })).status).toBe(400);
      failProvider = mode === "failure";
      const runResponse = await post("/run", { ...input, approval }); expect(runResponse.status).toBe(200);
      const result = (await runResponse.json()).data;
      expect(result.status).toBe(failProvider ? "reconcile_required" : "succeeded");
      if (!failProvider) expect(result.episodeId).toBeTruthy();
      await post("/run", { ...input, approval }); expect(modelCalls).toBe(before + 1);
      if (!failProvider) {
        const query = new URLSearchParams({ directory: workspace, projectId, episodeId: result.episodeId });
        const reviewData = await fetch(base + "/reviewData?" + query, { headers: { origin: base, "x-toonflow-workspace": "1" } });
        expect(reviewData.status).toBe(200);
        const review = (await reviewData.json()).data;
        expect(review.issues).toEqual([]);
        const decision = { directory: workspace, projectId, episodeId: result.episodeId,
          snapshotHash: review.snapshotHash, decision: "confirmed", note: "" };
        expect((await post("/review", decision, "https://untrusted.example.test")).status).toBe(403);
        expect((await post("/review", { ...decision, decision: "arbitrary" })).status).toBe(400);
        expect((await post("/review", { ...decision, projectId: crypto.randomUUID() })).status).toBe(404);
        expect((await post("/review", { ...decision, snapshotHash: "b".repeat(64) })).status).toBe(409);
        const accepted = await post("/review", decision); expect(accepted.status).toBe(200);
        expect((await accepted.json()).data.alreadyReviewed).toBe(false);
        expect((await (await post("/review", decision)).json()).data.alreadyReviewed).toBe(true);
        const next = await post("/prepare", { directory: workspace, projectId, options: { episodeNumber: 2,
          firstChapter: 1, lastChapter: 1, targetSeconds: 5, genre: "悬疑", visualStyle: "动画" } });
        expect(next.status).toBe(200);
        expect(modelCalls).toBe(before + 1);
      }
      await u.production.withProduction(workspace, (catalog, store) => {
        expect(catalog.getProjectProduction(projectId).episodes.length).toBe(failProvider ? 0 : 1);
        expect(store.getTextAuthorization(result.taskId)?.maxCalls).toBe(1);
        if (!failProvider) expect(JSON.parse(store.getTextOutput(result.taskId)!.usageJson).verifiedUsage).toMatchObject({ input: 100, output: 200 });
      });
    }
  } finally {
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    globalThis.fetch = originalFetch;
    if (oldData === undefined) delete process.env.TOONFLOW_DATA_DIR; else process.env.TOONFLOW_DATA_DIR = oldData;
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

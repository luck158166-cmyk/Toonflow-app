import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderTaskData } from "@toonflow/providers";

process.env.TOONFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), "arkProvider"));
process.env.NODE_ENV = "dev";
const { loadMediaProviderSource } = await import("../apps/server/src/utils/media/provider");
const source = readFileSync(resolve("packages/providers/src/media/volcengine.ts"), "utf8");
const model = "doubao-seedance-2-5-260628";
const request = { model, prompt: "清晨的港口", duration: 5, ratio: "9:16", resolution: "720p" };
const receipt = { kind: "arkVideo", version: 1, taskId: "arkQa1", model };
const result = { id: "arkQa1", model, status: "succeeded", content: { video_url: "https://media.example.test/video.mp4" },
  created_at: 1800000000, duration: 5, usage: { completion_tokens: 12, total_tokens: 13 } };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGEkAAAAASUVORK5CYII=", "base64");

async function setup(reply: (input: string, init?: RequestInit) => Promise<Response>, save?: (data: ProviderTaskData) => Promise<void>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const checkpoints: ProviderTaskData[] = [];
  const fakeFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init }); return reply(String(input), init);
  }, { preconnect: fetch.preconnect }) as typeof fetch;
  const provider = await loadMediaProviderSource(source, { apiKey: "qaSecretNeverSend" }, undefined, fakeFetch, undefined,
    save ?? (async data => { checkpoints.push(structuredClone(data)); }));
  return { provider, calls, checkpoints };
}

it("loads native metadata and preserves original image bytes, numbering, receipt and usage", async () => {
  const bytes = await new Bun.Image(png).resize(320, 320).png().buffer();
  const original = Buffer.from(bytes).toString("base64");
  const image = { type: "base64" as const, data: original, mimeType: "image/png" };
  const { provider, calls, checkpoints } = await setup(async (_url, init) => Response.json(init?.method === "POST" ? { id: "arkQa1" } : result));
  expect(provider.id).toBe("volcengine");
  expect(provider.models[0]?.durationResolutionMap?.[0]?.duration).toHaveLength(27);
  const output = await provider.generateVideo!({ ...request, prompt: "{{ref 2}} 在 {{ref 1}} 前", images: [image, image],
    referenceOrder: [{ type: "image", index: 1 }, { type: "image", index: 0 }] } as never);
  expect(output[0]).toMatchObject({ mediaType: "video", type: "url", url: result.content.video_url });
  expect(calls.map(call => call.init?.method)).toEqual(["POST", "GET"]);
  const sent = JSON.parse(String(calls[0]!.init?.body));
  expect(sent).toMatchObject({ model, omni_reference_task_type: "reference", duration: 5, ratio: "9:16", generate_audio: true });
  expect(sent.content).toEqual([{ type: "text", text: "图片1 在 图片2 前" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${original}` }, role: "reference_image" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${original}` }, role: "reference_image" }]);
  expect(checkpoints[0]).toEqual(receipt);
  expect(checkpoints[1]).toMatchObject({ status: "succeeded", usage: result.usage, created_at: result.created_at });
  expect(JSON.stringify(checkpoints)).not.toContain("qaSecretNeverSend");
  expect(calls.every(call => call.init?.redirect === "error")).toBe(true);
});

it("rejects unsupported or contradictory requests before submitting any paid request", async () => {
  const { provider, calls } = await setup(async () => { throw new Error("unexpected request"); });
  const asset = { type: "url", url: "asset://qaImage" };
  for (const patch of [
    { model: "unknown" }, { duration: 3 }, { duration: 3.5 }, { duration: 31 }, { duration: -1 },
    { resolution: "4k" }, { ratio: "2:1" }, { other: { draft: true } }, { audios: [asset] }, { videos: [asset] },
    { firstFrame: asset, images: [asset] }, { lastFrame: asset }, { firstFrame: asset, ratio: "9:16" },
    { images: Array(31).fill(asset) }, { mode: "text", images: [asset] }, { mode: ["imageReference:30"] },
    { mode: "startEndRequired", firstFrame: asset, ratio: "adaptive" },
    { prompt: "{{ref 1}}" }, { prompt: "a".repeat(4001) }, { images: [{ type: "url", url: "http://insecure.example.test/a.png" }] },
    { images: [{ type: "base64", data: "broken", mimeType: "image/png" }] },
    { images: [{ type: "base64", data: png.toString("base64"), mimeType: "image/png" }] },
  ]) await expect(provider.generateVideo!({ ...request, ...patch } as never)).rejects.toThrow();
  expect(calls).toHaveLength(0);
});

it("supports adaptive first and last frames without mixing reference roles", async () => {
  const { provider, calls } = await setup(async (_url, init) => Response.json(init?.method === "POST" ? { id: "arkQa1" } : result));
  await provider.generateVideo!({ ...request, ratio: "adaptive", mode: "startEndRequired",
    firstFrame: { type: "url", url: "asset://qaFirst" }, lastFrame: { type: "url", url: "asset://qaLast" } });
  const sent = JSON.parse(String(calls[0]!.init?.body));
  expect(sent.content.slice(1).map((item: { role: string }) => item.role)).toEqual(["first_frame", "last_frame"]);
  expect(sent.omni_reference_task_type).toBeUndefined();
  await provider.generateVideo!({ ...request, mode: "startFrameOptional" });
  expect(JSON.parse(String(calls[2]!.init?.body)).content).toEqual([{ type: "text", text: request.prompt }]);
});

it("never polls if receipt persistence fails, and resumes by GET without resubmission", async () => {
  const first = await setup(async () => Response.json({ id: "arkQa1" }), async () => { throw new Error("disk fault"); });
  await expect(first.provider.generateVideo!(request)).rejects.toThrow("disk fault");
  expect(first.calls.map(call => call.init?.method)).toEqual(["POST"]);
  const recovered = await setup(async () => Response.json(result));
  await recovered.provider.resumeTask!(receipt);
  expect(recovered.calls.map(call => call.init?.method)).toEqual(["GET"]);
});

it("rejects direct generation without a durable task and never retries unknown submission", async () => {
  let calls = 0;
  const fakeFetch = Object.assign(async () => { calls++; throw new Error("timeout after submission"); }, { preconnect: fetch.preconnect }) as typeof fetch;
  const direct = await loadMediaProviderSource(source, { apiKey: "qaSecretNeverSend" }, undefined, fakeFetch);
  await expect(direct.generateVideo!(request)).rejects.toThrow("持久化");
  expect(calls).toBe(0);
  const saved = await loadMediaProviderSource(source, { apiKey: "qaSecretNeverSend" }, undefined, fakeFetch, undefined, async () => {});
  await expect(saved.generateVideo!(request)).rejects.toThrow("timeout after submission");
  expect(calls).toBe(1);
});

it("preserves terminal and unknown states for reconciliation and redacts errors", async () => {
  for (const status of ["failed", "cancelled", "expired", "unknown"]) {
    const { provider, calls } = await setup(async () => Response.json({ ...result, status, error: { message: "blocked qaSecretNeverSend" } }));
    let error: unknown;
    try { await provider.resumeTask!(receipt); } catch (cause) { error = cause; }
    expect(error).toBeDefined();
    expect(String(error)).not.toContain("qaSecretNeverSend");
    expect((error as { code?: string }).code).not.toBe("MEDIA_TASK_FAILED");
    expect(calls.map(call => call.init?.method)).toEqual(["GET"]);
  }
  const malformed = await setup(async () => Response.json({ ...result, id: "wrongTask" }));
  await expect(malformed.provider.resumeTask!(receipt)).rejects.toThrow("不匹配");
  const rejected = await setup(async () => Response.json({ error: { message: "qaSecretNeverSend denied" } }, { status: 403 }));
  await expect(rejected.provider.generateVideo!(request)).rejects.toThrow("HTTP 403");
  expect(rejected.calls).toHaveLength(1);
});

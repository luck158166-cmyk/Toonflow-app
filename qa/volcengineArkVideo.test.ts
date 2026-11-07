import { describe, expect, it } from "bun:test";
import { VolcengineArkVideoAdapter } from "../packages/production/src/volcengineArkVideo";
import type { Task } from "../packages/production/src/store";

const task: Task = {
  id: "task-1", idempotencyKey: "shot-1-video", projectId: "project-1", episodeId: "episode-1",
  shotId: "shot-1", stage: "video", provider: "volcengine-ark", modelId: "doubao-seedance-2-5-260628",
  requestJson: JSON.stringify({ prompt: "A quiet harbor at dawn", destinationPath: "assets/shot-1.mp4",
    firstFrameUrl: "https://assets.example.test/start.jpg", referenceImages: ["https://assets.example.test/hero.png"],
    duration: 5, ratio: "9:16", generateAudio: true, watermark: true }),
  estimatedCostMicros: 50_000, currency: "CNY", billable: true,
  state: "running", providerTaskId: "ark-task-1", requestStarted: true, attempt: 1,
};

describe("Volcengine Ark Seedance adapter", () => {
  it("rejects durations outside the verified 4 to 30 second range before network submission", async () => {
    let calls = 0;
    const adapter = new VolcengineArkVideoAdapter("test-secret", { fetchImpl: async () => { calls++; return Response.json({ id: "qa" }); } });
    for (const duration of [2, 3, 3.5, 31]) await expect(adapter.submit({ ...task,
      requestJson: JSON.stringify({ prompt: "QA", destinationPath: "assets/qa.mp4", duration }) })).rejects.toThrow("4 to 30");
    expect(calls).toBe(0);
    for (const duration of [4, 30]) await adapter.submit({ ...task, requestJson: JSON.stringify({ prompt: "QA", destinationPath: "assets/qa.mp4", duration }) });
    expect(calls).toBe(2);
  });
  it("submits the official async task shape without exposing credentials in errors", async () => {
    let sentUrl = "";
    let sentInit: RequestInit | undefined;
    const adapter = new VolcengineArkVideoAdapter("test-secret", {
      baseUrl: "https://ark.example.test/api/v3",
      fetchImpl: async (input, init) => {
        sentUrl = String(input);
        sentInit = init;
        return new Response(JSON.stringify({ id: "ark-task-1" }), { status: 200 });
      },
    });
    expect(await adapter.submit(task)).toEqual({ providerTaskId: "ark-task-1" });
    expect(sentUrl).toBe("https://ark.example.test/api/v3/contents/generations/tasks");
    expect(new Headers(sentInit?.headers).get("Authorization")).toBe("Bearer test-secret");
    const body = JSON.parse(String(sentInit?.body));
    expect(body).toMatchObject({ model: "doubao-seedance-2-5-260628", duration: 5, ratio: "9:16", generate_audio: true, watermark: true });
    expect(body.content).toEqual([
      { type: "text", text: "A quiet harbor at dawn" },
      { type: "image_url", image_url: { url: "https://assets.example.test/start.jpg" }, role: "first_frame" },
      { type: "image_url", image_url: { url: "https://assets.example.test/hero.png" }, role: "reference_image" },
    ]);
  });

  it("polls output URL and expiry but leaves exact charge for later reconciliation", async () => {
    const adapter = new VolcengineArkVideoAdapter("test-secret", {
      baseUrl: "https://ark.example.test/api/v3",
      fetchImpl: async () => new Response(JSON.stringify({
        id: "ark-task-1", status: "succeeded", created_at: 1_800_000_000,
        content: { video_url: "https://signed.example.test/result.mp4?sig=opaque" },
      }), { status: 200 }),
    });
    expect(await adapter.poll("ark-task-1", task)).toEqual({
      state: "succeeded", remoteUrl: "https://signed.example.test/result.mp4?sig=opaque",
      destinationPath: "assets/shot-1.mp4", expiresAt: 1_800_000_000_000 + 24 * 60 * 60 * 1000,
      chargeStatus: "unknown",
    });
  });

  it("does not infer no-charge from a failed status", async () => {
    const adapter = new VolcengineArkVideoAdapter("test-secret", {
      fetchImpl: async () => new Response(JSON.stringify({ status: "failed" }), { status: 200 }),
    });
    expect(await adapter.poll("ark-task-1", task)).toEqual({ state: "failed", chargeStatus: "unknown" });
  });
});

import type { Task } from "./store";
import type { ProviderSubmissionPort } from "./dispatcher";
import type { ProviderPollingPort, ProviderPollResult } from "./providerReconciler";

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_MODEL = "doubao-seedance-2-5-260628";
const RESULT_URL_LIFETIME_MS = 24 * 60 * 60 * 1000;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type ArkVideoRequest = {
  prompt: string;
  destinationPath: string;
  referenceImages?: string[];
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  ratio?: string;
  duration?: number;
  resolution?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  outputFormat?: "mp4" | "mov";
};

type ArkTaskResponse = {
  id?: unknown;
  status?: unknown;
  created_at?: unknown;
  content?: { video_url?: unknown } | null;
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function parseRequest(task: Task): ArkVideoRequest {
  const value = object(JSON.parse(task.requestJson));
  if (typeof value.prompt !== "string" || !value.prompt.trim()) throw new TypeError("Ark video request requires a prompt.");
  if (typeof value.destinationPath !== "string" || !value.destinationPath.trim()) {
    throw new TypeError("Ark video request requires destinationPath.");
  }
  const strings = (input: unknown, label: string) => {
    if (input === undefined) return undefined;
    if (!Array.isArray(input) || input.some((item) => typeof item !== "string" || !item.trim())) {
      throw new TypeError(`${label} must be an array of non-empty strings.`);
    }
    return input as string[];
  };
  if (value.duration !== undefined && (!Number.isInteger(value.duration) || (value.duration as number) < 2 || (value.duration as number) > 30)) {
    throw new RangeError("Seedance 2.5 duration must be an integer from 2 to 30 seconds.");
  }
  for (const key of ["firstFrameUrl", "lastFrameUrl"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || !value[key].trim())) {
      throw new TypeError(`${key} must be a non-empty URL.`);
    }
  }
  return {
    prompt: value.prompt.trim(), destinationPath: value.destinationPath.trim(),
    referenceImages: strings(value.referenceImages, "referenceImages"),
    firstFrameUrl: value.firstFrameUrl as string | undefined,
    lastFrameUrl: value.lastFrameUrl as string | undefined,
    ratio: value.ratio as string | undefined,
    duration: value.duration as number | undefined,
    resolution: value.resolution as string | undefined,
    generateAudio: value.generateAudio as boolean | undefined,
    watermark: value.watermark as boolean | undefined,
    outputFormat: value.outputFormat as "mp4" | "mov" | undefined,
  };
}

function assertHttpOk(response: Response) {
  if (!response.ok) throw new Error(`Ark video API returned HTTP ${response.status}.`);
}

/** Real Ark Seedance 2.5 adapter. It performs no calls until submit/poll are invoked. */
export class VolcengineArkVideoAdapter implements ProviderSubmissionPort, ProviderPollingPort {
  readonly providerId = "volcengine-ark";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(apiKey: string, options: {
    baseUrl?: string; model?: string; fetchImpl?: FetchLike;
  } = {}) {
    if (!apiKey.trim()) throw new TypeError("ARK_API_KEY is required to configure the Ark adapter.");
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = options.model ?? DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  async submit(task: Task): Promise<{ providerTaskId: string }> {
    if (task.stage !== "video") throw new TypeError("Ark Seedance adapter only accepts video tasks.");
    const request = parseRequest(task);
    if (task.modelId && task.modelId !== this.model) throw new Error("Task model does not match the configured Ark model.");
    const content: Array<Record<string, unknown>> = [{ type: "text", text: request.prompt }];
    if (request.firstFrameUrl) content.push({ type: "image_url", image_url: { url: request.firstFrameUrl }, role: "first_frame" });
    if (request.lastFrameUrl) content.push({ type: "image_url", image_url: { url: request.lastFrameUrl }, role: "last_frame" });
    for (const url of request.referenceImages ?? []) content.push({ type: "image_url", image_url: { url }, role: "reference_image" });

    const body: Record<string, unknown> = { model: this.model, content };
    for (const key of ["ratio", "duration", "resolution", "generateAudio", "watermark"] as const) {
      const apiKey = key === "generateAudio" ? "generate_audio" : key;
      if (request[key] !== undefined) body[apiKey] = request[key];
    }
    if (request.outputFormat) body.output_format = request.outputFormat;

    const response = await this.fetchImpl(`${this.baseUrl}/contents/generations/tasks`, {
      method: "POST", headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assertHttpOk(response);
    const result = object(await response.json());
    if (typeof result.id !== "string" || !result.id.trim()) throw new Error("Ark video API response did not include a task ID.");
    return { providerTaskId: result.id };
  }

  async poll(providerTaskId: string, task?: Task): Promise<ProviderPollResult> {
    if (!providerTaskId.trim()) throw new TypeError("Ark task ID is required.");
    if (!task) throw new TypeError("Ark task reconciliation requires the persisted task record.");
    const response = await this.fetchImpl(`${this.baseUrl}/contents/generations/tasks/${encodeURIComponent(providerTaskId)}`, {
      method: "GET", headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
    });
    assertHttpOk(response);
    const result = await response.json() as ArkTaskResponse;
    const status = typeof result.status === "string" ? result.status : "unknown";
    if (status === "queued" || status === "running") return { state: "running" };
    if (status === "failed" || status === "cancelled" || status === "expired") {
      // Ark's task status does not establish the amount billed. Keep the reservation for reconciliation.
      return { state: "failed", chargeStatus: "unknown" };
    }
    if (status !== "succeeded") throw new Error(`Ark video API returned an unsupported task status: ${status}.`);
    const url = object(result.content).video_url;
    if (typeof url !== "string" || !/^https:\/\//i.test(url)) throw new Error("Succeeded Ark task has no HTTPS video URL.");
    if (!Number.isSafeInteger(result.created_at) || (result.created_at as number) <= 0) {
      throw new Error("Succeeded Ark task has no valid created_at timestamp for result expiry.");
    }
    const request = parseRequest(task);
    return {
      state: "succeeded", remoteUrl: url, destinationPath: request.destinationPath,
      expiresAt: (result.created_at as number) * 1000 + RESULT_URL_LIFETIME_MS,
      chargeStatus: "unknown",
    };
  }
}

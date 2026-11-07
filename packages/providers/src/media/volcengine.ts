/// <reference path="../../types.d.ts" />

// 官方协议：https://ark.volcengine.com/region:cn-beijing/docs/create-video-generation-task-api.md
// 恢复协议：https://ark.volcengine.com/region:cn-beijing/docs/get-video-generation-task-api.md
const baseUrl = "https://ark.cn-beijing.volces.com/api/v3";
const videoModel = "doubao-seedance-2-5-260628";
const imageModel = "doubao-seedream-5-0-pro-260628";
const rules = [{ type: "input", field: "apiKey", title: "火山方舟 API Key", value: "", props: { type: "password", showPassword: true } }] as const;
type Context = ProviderContext<{ apiKey: string }>;
type ReferencedVideoRequest = VideoRequest & {
  referenceOrder?: ({ type: "image" | "video" | "audio"; index: number } | { type: "firstFrame" | "lastFrame" | "text" })[];
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("方舟返回的数据不是有效对象");
  return value as Record<string, unknown>;
}

function apiKey(context: Context) {
  const key = context.config.apiKey?.trim().replace(/^Bearer\s+/i, "");
  if (!key) throw new Error("请在模型与设置中填写火山方舟 API Key");
  return key;
}

function taskId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(value)) throw new Error("方舟任务 ID 无效，须先核对平台记录，不能自动重提");
  return value;
}

function httpsUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("方舟结果缺少 HTTPS 地址");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("方舟媒体地址必须使用无内嵌凭据的 HTTPS");
  return value;
}

function imageUrl(input: MediaInput): string {
  if (input.type === "url") {
    if (/^asset:\/\/[a-zA-Z0-9_-]+$/.test(input.url)) return input.url;
    return httpsUrl(input.url);
  }
  // 原图只编码传输，不压缩、裁剪或重编码；这不代表已获平台人脸信任。
  if (!["image/png", "image/jpeg", "image/webp"].includes(input.mimeType)) throw new Error("方舟本地参考图须为 PNG、JPEG 或 WebP 原图");
  const bytes = input.type === "binary" ? Buffer.from(input.data) : Buffer.from(input.data, "base64");
  if (!bytes.length || bytes.length >= 30 * 1024 * 1024) throw new Error("方舟单张参考图须小于 30 MB 且不能为空");
  if (input.type === "base64" && bytes.toString("base64") !== input.data) throw new Error("方舟参考图 Base64 无效");
  return `data:${input.mimeType};base64,${bytes.toString("base64")}`;
}

function promptText(request: ReferencedVideoRequest) {
  return request.prompt.replace(/\{\{ref (\d+)\}\}/g, (_match, number: string) => {
    const reference = request.referenceOrder?.[Number(number) - 1];
    if (reference?.type === "image" && Number.isInteger(reference.index) && reference.index >= 0 && request.images?.[reference.index]) return `图片${reference.index + 1}`;
    if (reference?.type === "firstFrame" && request.firstFrame) return "首帧图片";
    if (reference?.type === "lastFrame" && request.lastFrame) return "尾帧图片";
    throw new Error(`方舟提示词引用 ${number} 没有对应图片`);
  });
}

async function requestJson(context: Context, path: string, signal: AbortSignal, body?: string) {
  const response = await context.tool.fetch(baseUrl + path, {
    method: body === undefined ? "GET" : "POST", redirect: "error", signal,
    headers: { Authorization: `Bearer ${apiKey(context)}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
  if (!response.ok) {
    const detail = context.tool.errorMessage(await response.text());
    throw new Error(`方舟接口 HTTP ${response.status}${detail ? `：${detail}` : ""}；保留任务记录，请先核对状态与费用`);
  }
  return object(await response.json());
}

function imageReceipt(data: ProviderTaskData): MediaAsset[] {
  if (data.kind !== "arkImage" || data.version !== 1 || data.model !== imageModel || data.mode !== "textToImage"
    || typeof data.created !== "number" || !Number.isSafeInteger(data.created) || data.created < 1
    || data.created > Date.now() / 1000 + 300) throw new Error("方舟图片回执无效，不能重新提交");
  if (Date.now() >= data.created * 1000 + 24 * 60 * 60_000) throw new Error("方舟图片原链接已超过有效期；请核对平台或备份，不能自动付费重生成");
  return [{ mediaType: "image", type: "url", url: httpsUrl(data.url), mimeType: "image/png" }];
}

function executionSignal(context: Context) {
  // ACT: 一次等待最多 30 分钟；超时只是本地中断，恢复只查询原任务。
  return AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(context.signal ? [context.signal] : [])]);
}

async function waitInterval(signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 5000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function pollVideo(context: Context, data: ProviderTaskData, signal: AbortSignal): Promise<MediaAsset[]> {
  const id = taskId(data.taskId);
  while (true) {
    signal.throwIfAborted();
    const result = await requestJson(context, `/contents/generations/tasks/${encodeURIComponent(id)}`, signal);
    if (result.id !== id || result.model !== data.model) throw new Error("方舟查询结果的任务或模型不匹配，保留记录等待核对");
    if (result.status === "queued" || result.status === "running") { await waitInterval(signal); continue; }
    if (["failed", "cancelled", "expired"].includes(String(result.status))) {
      const detail = context.tool.errorMessage(result.error);
      // 不使用宿主 MEDIA_TASK_FAILED 自动释放费用：平台失败状态并不证明未扣费。
      throw new Error(`方舟任务已${result.status === "failed" ? "失败" : result.status === "cancelled" ? "取消" : "超时"}${detail ? `：${detail}` : ""}；不得自动重提，费用须对账`);
    }
    if (result.status !== "succeeded") throw new Error("方舟任务状态未知，不能自动重提");
    const content = object(result.content);
    const url = httpsUrl(content.video_url);
    const receipt: ProviderTaskData = { ...data, status: "succeeded" };
    for (const field of ["created_at", "updated_at", "duration", "frames", "seed"] as const) {
      if (typeof result[field] === "number" && Number.isFinite(result[field])) receipt[field] = result[field];
    }
    if (result.usage && typeof result.usage === "object" && !Array.isArray(result.usage)) {
      receipt.usage = Object.fromEntries(Object.entries(result.usage).filter(([, value]) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0));
    }
    if (content.last_frame_url !== undefined) receipt.lastFrameUrl = httpsUrl(content.last_frame_url);
    await context.saveTaskData?.(receipt);
    return [{ mediaType: "video", type: "url", url, mimeType: "video/mp4" }];
  }
}

export default {
  id: "volcengine", label: "火山方舟", icon: "", version: "1.1.0", apiUrl: baseUrl, rules,
  readme: "Seedance 2.5 视频与 Seedream 5.0 pro 单张文生图。Seedream 原始 PNG 不作缩放或裁剪，当前支持 1024×1024、800×1424；图片响应先保存再下载，恢复只下载已有结果，不重发生成。人物素材是否可用于视频还须检查来源、原字节、同账号与有效期。视频支持文本、参考图和首尾帧；暂不支持音视频参考、样片转正式或语音生成。价格须在生产成本中心确认。",
  models: [{ id: "doubao-seedance-2-5-260628", label: "Seedance 2.5", type: "video", audio: "optional",
    mode: ["text", ["imageReference:30"], "startFrameOptional", "startEndRequired"],
    imageRatios: ["9:16", "16:9", "4:3", "1:1", "3:4", "21:9", "adaptive"],
    durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p", "1080p"] }],
  }, { id: "doubao-seedream-5-0-pro-260628", label: "Seedream 5.0 pro · 资产文生图", type: "image", mode: ["text"],
    imageSizes: ["1024x1024", "800x1424"], imageRatios: ["1:1", "9:16"] }],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    apiKey(this);
    if (!this.saveTaskData) throw new Error("方舟图片必须通过可持久化的宿主任务执行");
    if (request.model !== imageModel) throw new Error("当前仅支持 Seedream 5.0 pro 固定版本");
    const size = request.size ?? "1024x1024";
    if (!["1024x1024", "800x1424"].includes(size)) throw new Error("当前资产文生图仅支持 1024x1024 或 800x1424 原始尺寸");
    if (request.ratio && request.ratio !== (size === "1024x1024" ? "1:1" : "9:16")) throw new Error("图片宽高比与尺寸不匹配");
    if (request.images?.length || request.other && Object.keys(request.other).length) throw new Error("当前资产入口仅支持单张文生图，不接受参考图、图层或扩展参数");
    if (!request.prompt.trim() || [...request.prompt].length > 2000) throw new Error("图片提示词须为 1–2000 字符");
    const result = await requestJson(this, "/images/generations", executionSignal(this), JSON.stringify({ model: imageModel,
      prompt: request.prompt, size, output_format: "png", response_format: "url", watermark: false }));
    if (result.model !== imageModel || !Array.isArray(result.data) || result.data.length !== 1) throw new Error("方舟图片响应模型或数量不匹配，须核对费用，不能重提");
    const output = object(result.data[0]);
    if (output.error || output.output_format && output.output_format !== "png") throw new Error("方舟图片生成失败或原图格式不符，请核对费用");
    if (typeof result.created !== "number" || typeof output.size !== "string" || output.size !== size) throw new Error("方舟图片时间或尺寸回执无效，请核对原任务");
    const data: ProviderTaskData = { kind: "arkImage", version: 1, model: imageModel, mode: "textToImage",
      created: result.created, url: httpsUrl(output.url), size: output.size, requestedSize: size };
    if (result.usage && typeof result.usage === "object" && !Array.isArray(result.usage)) data.usage = Object.fromEntries(
      Object.entries(result.usage).filter(([, value]) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0));
    const assets = imageReceipt(data);
    await this.saveTaskData(data);
    return assets;
  },
  async generateVideo(request: ReferencedVideoRequest): Promise<MediaAsset[]> {
    apiKey(this);
    if (!this.saveTaskData) throw new Error("方舟视频须通过可持久化的媒体任务提交，缺少任务保存能力");
    if (request.model !== videoModel) throw new Error("此版本方舟供应商只支持已核对的 Seedance 2.5 模型");
    if (!request.prompt.trim() || [...request.prompt].length > 4000) throw new Error("Seedance 提示词须为 1–4000 字符");
    if (!Number.isInteger(request.duration) || request.duration! < 4 || request.duration! > 30) throw new Error("Seedance 2.5 须指定 4–30 整数秒，不能自动选择付费时长");
    const resolution = request.resolution ?? "720p";
    if (!["480p", "720p", "1080p"].includes(resolution)) throw new Error("Seedance 2.5 不支持此分辨率");
    if (request.videos?.length || request.audios?.length) throw new Error("此版本尚未接通视频或音频参考，不能忽略已选素材");
    if (request.other && Object.keys(request.other).length) throw new Error("此版本尚不支持方舟扩展参数，不能静默忽略");
    const images = request.images ?? [];
    const hasFrames = !!(request.firstFrame || request.lastFrame);
    if (images.length > 30 || (hasFrames && images.length) || (request.lastFrame && !request.firstFrame)) throw new Error("方舟首尾帧与参考图模式不能混用，参考图最多 30 张，尾帧须搭配首帧");
    const mode = request.mode;
    if (mode === "text" && (images.length || hasFrames)
      || Array.isArray(mode) && (mode.length !== 1 || mode[0] !== "imageReference:30" || !images.length || hasFrames)
      || ["endFrameOptional", "startEndRequired"].includes(String(mode)) && (!request.firstFrame || images.length)
      || mode === "startFrameOptional" && images.length
      || mode === "startEndRequired" && !request.lastFrame
      || mode === "singleImage" && (images.length !== 1 || hasFrames)) throw new Error("方舟生成模式与实际素材不一致");
    const ratio = request.ratio ?? (hasFrames ? "adaptive" : "9:16");
    if (!["9:16", "16:9", "4:3", "1:1", "3:4", "21:9", "adaptive"].includes(ratio) || hasFrames && ratio !== "adaptive") throw new Error("方舟首尾帧仅支持 adaptive 比例，其他任务须使用模型支持的比例");
    const content: Record<string, unknown>[] = [{ type: "text", text: promptText(request) }];
    const inputs = [...images.map(image => ({ image, role: "reference_image" })),
      ...(request.firstFrame ? [{ image: request.firstFrame, role: "first_frame" }] : []),
      ...(request.lastFrame ? [{ image: request.lastFrame, role: "last_frame" }] : [])];
    for (const { image, role } of inputs) {
      const url = imageUrl(image);
      if (!url.startsWith("asset://")) {
        const { width, height } = await this.tool.media.inspectImage(image);
        if (width < 300 || height < 300 || width > 6000 || height > 6000 || width / height < 0.4 || width / height > 2.5) throw new Error("方舟参考图边长须为 300–6000 像素，宽高比须在 0.4–2.5 之间；请使用合规原图");
      }
      content.push({ type: "image_url", image_url: { url }, role });
    }
    const body = JSON.stringify({ model: request.model, content, duration: request.duration, ratio, resolution,
      generate_audio: request.generateAudio ?? true, watermark: request.watermark ?? false, output_format: "mp4",
      ...(images.length ? { omni_reference_task_type: "reference" } : {}),
    });
    if (Buffer.byteLength(body) > 64 * 1024 * 1024) throw new Error("方舟请求体超过 64 MB，请减少原图或使用经授权的素材地址");
    const signal = executionSignal(this);
    const result = await requestJson(this, "/contents/generations/tasks", signal, body);
    const data: ProviderTaskData = { kind: "arkVideo", version: 1, taskId: taskId(result.id), model: request.model };
    await this.saveTaskData?.(data);
    return pollVideo(this, data, signal);
  },
  async resumeTask(data: ProviderTaskData): Promise<MediaAsset[]> {
    if (data.kind === "arkImage") return imageReceipt(data);
    if (data.kind !== "arkVideo" || data.version !== 1 || data.model !== videoModel) throw new Error("方舟任务恢复数据无效");
    taskId(data.taskId);
    apiKey(this);
    return pollVideo(this, data, executionSignal(this));
  },
} satisfies ProviderDefinition<typeof rules>;

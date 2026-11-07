import type { TextGenerationPort } from "@toonflow/production";
import { getConfiguredModel, streamAi } from "@/utils/ai";

export async function createProductionTextProvider(providerId: string, modelId: string, maxOutputTokens: number) {
  const configured = await getConfiguredModel(providerId, modelId);
  if (configured.execution || configured.route) throw new Error("当前编剧执行仅支持本地配置的直连模型");
  const destination = new URL(configured.baseUrl);
  if (destination.protocol !== "https:" || destination.username || destination.password || destination.search || destination.hash) {
    throw new Error("编剧模型地址必须为不含凭据或查询参数的 HTTPS 地址");
  }
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > configured.model.maxOutputTokens) {
    throw new Error("输出 token 上限超过当前模型配置");
  }
  const port: TextGenerationPort = {
    providerId,
    async generate(task) {
      if (task.modelId !== modelId || !task.billable || !task.requestStarted) throw new Error("编剧模型与已授权任务不匹配");
      const input = JSON.parse(task.requestJson) as { system: string };
      if (typeof input.system !== "string") throw new Error("编剧输入缺少系统指令");
      const { system, ...data } = input;
      const signal = AbortSignal.timeout(5 * 60 * 1000);
      const stream = streamAi(configured, { systemPrompt: system,
        messages: [{ role: "user", content: JSON.stringify(data), timestamp: Date.now() }] }, signal, [], { maxOutputTokens });
      for await (const _event of stream) { /* The host SDK accumulates the complete response. */ }
      const message = await stream.result();
      if (["error", "aborted"].includes(message.stopReason)) throw new Error(message.errorMessage || "编剧模型执行失败");
      if (!message.responseId) throw new Error("模型未返回可追溯的响应编号，需人工对账");
      return { responseText: message.content.filter(part => part.type === "text").map(part => part.text).join(""),
        providerRequestId: message.responseId,
        usageJson: JSON.stringify({ verifiedUsage: await stream.billingUsage() ?? null,
          sdkUsage: message.usage, stopReason: message.stopReason }) };
    },
  };
  return { port, model: { providerId, modelId,
    destination: `${configured.provider.protocol} · ${destination.href}`,
    contextWindow: configured.model.contextWindow, maxOutputTokensLimit: configured.model.maxOutputTokens } };
}

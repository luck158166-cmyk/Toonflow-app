import { Router } from "express";
import { z } from "zod";
import { executeAdaptation } from "@toonflow/production";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { adaptationExecutionFields } from "@/lib/adaptationExecutionSchema";
import { episodeDraftSchema } from "@/lib/episodeDraftSchema";

export default Router().post("/", validateFields({ ...adaptationExecutionFields,
  approval: z.object({ approved: z.literal(true), maxCalls: z.literal(1),
    planHash: z.string().regex(/^[a-f0-9]{64}$/), maxCostMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  try {
    const { model, port } = await u.production.createProductionTextProvider(req.body.providerId, req.body.modelId, req.body.maxOutputTokens);
    const data = await u.production.withProduction(directory, (catalog, store) => executeAdaptation(catalog, store,
      { projectId: req.body.projectId, inputId: req.body.inputId, maxOutputTokens: req.body.maxOutputTokens }, model,
      req.body.approval, port, value => {
        const result = episodeDraftSchema.safeParse(value);
        if (!result.success) throw new Error(result.error.issues.slice(0, 5).map(item => `${item.path.join(".")}：${item.message}`).join("；"));
        return result.data;
      }));
    res.json(success(data));
  } catch (cause) {
    res.status(422).json(error(cause instanceof Error ? cause.message : "编剧执行未能开始", null, 422));
  }
});

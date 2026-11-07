import { Router } from "express";
import { previewAdaptationExecution } from "@toonflow/production";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { adaptationExecutionFields } from "@/lib/adaptationExecutionSchema";

export default Router().post("/", validateFields(adaptationExecutionFields), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  try {
    const { model } = await u.production.createProductionTextProvider(req.body.providerId, req.body.modelId, req.body.maxOutputTokens);
    const data = await u.production.withProduction(directory, (catalog, store) => previewAdaptationExecution(catalog, store,
      { projectId: req.body.projectId, inputId: req.body.inputId, maxOutputTokens: req.body.maxOutputTokens }, model));
    res.json(success(data));
  } catch (cause) {
    res.status(422).json(error(cause instanceof Error ? cause.message : "编剧执行预览失败", null, 422));
  }
});

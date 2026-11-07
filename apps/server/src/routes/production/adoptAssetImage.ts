import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { assetImageTaskFields } from "@/lib/assetImageSchema";
export default Router().post("/", validateFields({ ...assetImageTaskFields, rightsConfirmed: z.literal(true) }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  try { res.json(success(await u.production.adoptAssetImage(directory, req.body.projectId, req.body.taskId, req.body.rightsConfirmed))); }
  catch (cause) { res.status(409).json(error(cause instanceof Error ? cause.message : "资产图片操作失败", null, 409)); }
});

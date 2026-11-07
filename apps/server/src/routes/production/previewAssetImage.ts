import { Router } from "express";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { assetImageFields } from "@/lib/assetImageSchema";
export default Router().post("/", validateFields({ ...assetImageFields }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const input = { projectId: req.body.projectId, entityKind: req.body.entityKind, entityId: req.body.entityId, role: req.body.role, visualStyle: req.body.visualStyle };
  try { res.json(success(await u.production.inspectAssetImage(directory, input))); }
  catch (cause) { res.status(409).json(error(cause instanceof Error ? cause.message : "资产图片操作失败", null, 409)); }
});

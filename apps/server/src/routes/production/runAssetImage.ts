import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { assetImageFields } from "@/lib/assetImageSchema";
export default Router().post("/", validateFields({ ...assetImageFields, approval: z.object({ approved: z.literal(true), maxCalls: z.literal(1), planHash: z.string().regex(/^[a-f0-9]{64}$/), maxCostMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict() }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const input = { projectId: req.body.projectId, entityKind: req.body.entityKind, entityId: req.body.entityId, role: req.body.role, visualStyle: req.body.visualStyle };
  try { res.json(success(await u.production.executeAssetImage(directory, input, req.body.approval))); }
  catch (cause) { res.status(409).json(error(cause instanceof Error ? cause.message : "资产图片操作失败", null, 409)); }
});

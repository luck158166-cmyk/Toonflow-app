import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { assetImageTaskFields } from "@/lib/assetImageSchema";
export default Router().post("/", validateFields({ ...assetImageTaskFields, expectedAdoptionId: z.uuid().nullable(),
  review: z.object({ pictureConfirmed: z.literal(true), continuityConfirmed: z.literal(true), audioConfirmed: z.literal(true), rightsConfirmed: z.literal(true), note: z.string().trim().min(1).max(2000) }).strict() }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  try { res.json(success(await u.production.adoptProductionSegmentVideo(directory, req.body.projectId, req.body.taskId, req.body.expectedAdoptionId, req.body.review))); }
  catch (cause) { res.status(409).json(error(cause instanceof Error ? cause.message : "视频采用失败", null, 409)); }
});

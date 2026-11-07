import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { segmentExecutionFields } from "@/lib/segmentExecutionSchema";

export default Router().post("/", validateFields({ ...segmentExecutionFields, approval: z.object({ approved: z.literal(true), maxCalls: z.literal(1), planHash: z.string().regex(/^[a-f0-9]{64}$/), maxCostMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict() }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const input = { projectId: req.body.projectId, episodeId: req.body.episodeId, sequence: req.body.sequence, inputHash: req.body.inputHash };
  try { res.json(success(await u.production.executeSegmentVideo(directory, input, req.body.approval))); }
  catch (cause) { res.status(409).json(error(cause instanceof Error ? cause.message : "片段投产操作失败", null, 409)); }
});

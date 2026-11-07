import { Router } from "express";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { segmentExecutionFields } from "@/lib/segmentExecutionSchema";

export default Router().post("/", validateFields({ ...segmentExecutionFields }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const input = { projectId: req.body.projectId, episodeId: req.body.episodeId, sequence: req.body.sequence, inputHash: req.body.inputHash };
  try { res.json(success(await u.production.inspectSegmentExecution(directory, input))); }
  catch (cause) { res.status(409).json(error(cause instanceof Error ? cause.message : "片段投产操作失败", null, 409)); }
});

import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ directory: z.string().min(1), projectId: z.uuid(), taskId: z.uuid() }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) throw Object.assign(new Error("当前仅支持本地工作区"), { status: 403 });
  res.json(success(await u.production.recoverProductionVideoTask(directory, req.body.projectId, req.body.taskId)));
});

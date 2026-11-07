import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { adoptAdaptationResponse } from "@toonflow/production";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { episodeDraftSchema } from "@/lib/episodeDraftSchema";

const router = Router();
export default router.post("/", validateFields({ directory: z.string().min(1).max(4096), projectId: z.uuid(), taskId: z.uuid() }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const result = await u.production.withProduction(directory, (catalog, store) => {
    try {
      const task = store.getTask(req.body.taskId);
      if (task.projectId !== req.body.projectId || !catalog.getStory(req.body.projectId)) throw new Error("任务不属于当前故事");
      const inputId = createHash("sha256").update(task.requestJson).digest("hex");
      return { data: adoptAdaptationResponse(catalog, store, req.body.projectId, inputId, task.id,
        value => episodeDraftSchema.parse(value)) };
    } catch (cause) {
      return { message: cause instanceof z.ZodError ? cause.issues.slice(0, 5).map(item => `${item.path.join(".")}：${item.message}`).join("；")
        : cause instanceof Error ? cause.message : "编剧结果采用失败" };
    }
  });
  if (result.message) return res.status(422).json(error(result.message, null, 422));
  res.json(success(result.data));
});

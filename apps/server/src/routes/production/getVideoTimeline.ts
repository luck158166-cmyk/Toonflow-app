import { Router } from "express";
import { z } from "zod";
import { getEpisodeVideoTimeline } from "@toonflow/production";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096), projectId: z.uuid(), episodeId: z.uuid() }, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  try { res.json(success(await u.production.withProduction(directory, (catalog, store) => ({
    ...getEpisodeVideoTimeline(catalog, req.query.projectId as string, req.query.episodeId as string),
    renders: store.listProjectTasks(req.query.projectId as string).filter(task => task.stage === "synthesis" && task.episodeId === req.query.episodeId)
      .map(task => ({ taskId: task.id, state: task.state, version: store.getSynthesisExport(task.id)?.version, updatedAt: task.updatedAt })),
  })))); }
  catch (cause) { res.status(409).json(error(cause instanceof Error ? cause.message : "时间线读取失败", null, 409)); }
});

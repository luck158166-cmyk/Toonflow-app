import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();

export default router.get("/", validateFields({
  directory: z.string().min(1).max(4096),
  projectId: z.uuid(),
  episodeId: z.uuid(),
}, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  if (!u.workspace.isLocalWorkspaceRequest(req)) throw Object.assign(new Error("分集费用目前仅支持本地工作区"), { status: 403 });
  const projectId = req.query.projectId as string;
  const episodeId = req.query.episodeId as string;
  const result = await u.production.withProduction(directory, (catalog, store) => {
    const episode = catalog.getEpisode(episodeId);
    if (!catalog.getStory(projectId) || episode?.projectId !== projectId) return null;
    return { episode, breakdown: store.getEpisodeCostBreakdown(projectId, episodeId),
      charges: store.listEpisodeCharges(projectId, episodeId) };
  });
  if (!result) return res.status(404).json(error("当前故事没有这一集", null, 404));
  res.json(success(result));
});

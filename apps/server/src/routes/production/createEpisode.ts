import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();

export default router.post("/", validateFields({
  directory: z.string().min(1).max(4096),
  projectId: z.uuid(),
  episodeNumber: z.number().int().positive().safe(),
  title: z.string().trim().min(1).max(200),
  logline: z.string().max(2000).optional(),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  const { projectId, episodeNumber, title, logline } = req.body;
  const result = await u.production.withProduction(directory, catalog => {
    if (!catalog.getStory(projectId)) return { status: 404 as const };
    if (catalog.listEpisodes(projectId).some(episode => episode.episodeNumber === episodeNumber)) return { status: 409 as const };
    const episodeId = catalog.createEpisode(projectId, episodeNumber, title.trim(), logline ?? "");
    return { status: 201 as const, episode: catalog.getEpisode(episodeId) };
  });
  if (result.status === 404) return res.status(404).json(error("当前工作区没有这个故事", null, 404));
  if (result.status === 409) return res.status(409).json(error("这一集的序号已存在", null, 409));
  res.status(201).json(success({ episode: result.episode }));
});

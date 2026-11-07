import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();

export default router.get("/", validateFields({
  directory: z.string().min(1).max(4096),
  projectId: z.uuid(),
}, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  const projectId = req.query.projectId as string;
  const episodes = await u.production.withProduction(directory, catalog =>
    catalog.getStory(projectId) ? catalog.listEpisodes(projectId) : null);
  if (!episodes) return res.status(404).json(error("当前工作区没有这个故事", null, 404));
  res.json(success({ episodes }));
});

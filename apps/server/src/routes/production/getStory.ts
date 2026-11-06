import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();

export default router.get("/", validateFields({
  directory: z.string().min(1),
  projectId: z.string().uuid(),
}, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  const story = await u.production.withProduction(directory, catalog => catalog.getStory(req.query.projectId as string));
  if (!story) return res.status(404).json(error("找不到这个故事", null, 404));
  res.json(success({ story }));
});

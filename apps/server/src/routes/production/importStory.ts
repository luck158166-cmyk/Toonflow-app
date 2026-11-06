import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.post("/", validateFields({
  directory: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  sourceKind: z.enum(["synopsis", "novel", "script"]),
  sourceText: z.string().trim().min(1).max(1_000_000),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  const { title, sourceKind, sourceText } = req.body;
  const projectId = await u.production.withProduction(directory, catalog => catalog.importStory({
    title: title.trim(), sourceKind, sourceText: sourceText.trim(),
  }));
  res.status(201).json(success({ projectId }));
});

import { Router } from "express";
import { z } from "zod";
import { prepareAdaptationInput } from "@toonflow/production";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { directedEpisodeSchema } from "@/lib/episodeDraftSchema";

const router = Router();
export default router.post("/", validateFields({ directory: z.string().min(1).max(4096), projectId: z.uuid(),
  options: z.object({ episodeNumber: z.number().int().positive(), firstChapter: z.number().int().positive(),
    lastChapter: z.number().int().positive(), targetSeconds: z.number().int().min(1).max(600),
    genre: z.string().min(1).max(200), visualStyle: z.string().min(1).max(200) }).strict(),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const result = await u.production.withProduction(directory, catalog => {
    try { return { data: prepareAdaptationInput(catalog, req.body.projectId, req.body.options,
      z.toJSONSchema(directedEpisodeSchema)) }; }
    catch (cause) { return { message: cause instanceof Error ? cause.message : "编剧输入准备失败" }; }
  });
  if (result.message) return res.status(422).json(error(result.message, null, 422));
  res.json(success(result.data));
});

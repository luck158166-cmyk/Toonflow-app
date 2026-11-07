import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { applyEpisodeDraft } from "@toonflow/production";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { episodeDraftSchema } from "@/lib/episodeDraftSchema";

const router = Router();
export default router.post("/", validateFields({ directory: z.string().min(1).max(4096),
  projectId: z.uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), draft: episodeDraftSchema,
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const result = await u.production.withProduction(directory, catalog => {
    const story = catalog.getStory(req.body.projectId);
    if (!story) return { status: 404, message: "当前工作区没有这个故事" };
    if (createHash("sha256").update(story.sourceText).digest("hex") !== req.body.sourceHash) {
      return { status: 409, message: "草稿的原文版本不匹配，请根据当前原文重新生成" };
    }
    if (catalog.listEpisodes(story.id).some(item => item.episodeNumber === req.body.draft.episodeNumber)) {
      return { status: 409, message: "这一集已存在，未覆盖已有剧本和产物" };
    }
    try { return { status: 201, data: applyEpisodeDraft(catalog, story.id, req.body.draft) }; }
    catch (cause) { return { status: 422, message: cause instanceof Error ? cause.message : "草稿未通过校验" }; }
  });
  if (result.status !== 201) return res.status(result.status).json(error(result.message ?? "草稿未采用", null, result.status));
  res.status(201).json(success(result.data));
});

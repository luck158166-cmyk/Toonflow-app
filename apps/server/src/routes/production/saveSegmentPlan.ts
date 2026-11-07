import { Router } from "express";
import { z } from "zod";
import { saveEpisodeSegmentPlan } from "@toonflow/production";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096),
  projectId: z.uuid(), episodeId: z.uuid(), inputHash: z.string().regex(/^[a-f0-9]{64}$/) }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const input = req.body as { directory: string; projectId: string; episodeId: string; inputHash: string };
  const directory = await u.workspace.resolveWorkspace(req, input.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const result = await u.production.withProduction(directory, async catalog => {
    try {
      const report = await u.production.inspectEpisodeSegmentPlan(directory, catalog, input.projectId, input.episodeId);
      if (!report.canSave) throw new Error(report.fileIssues[0]?.message ?? "片段还有未解决的检查项");
      return { data: saveEpisodeSegmentPlan(catalog, input.projectId, input.episodeId, input.inputHash) };
    } catch (cause) { return { message: cause instanceof Error ? cause.message : "片段规划失败" }; }
  });
  if (result.message) return res.status(409).json(error(result.message, null, 409));
  res.json(success(result.data));
});

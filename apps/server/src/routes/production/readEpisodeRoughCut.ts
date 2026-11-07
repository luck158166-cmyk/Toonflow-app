import { Router } from "express";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error } from "@/lib/responseFormat";
import { assetImageTaskFields } from "@/lib/assetImageSchema";
export default Router().get("/", validateFields(assetImageTaskFields, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  try {
    const bytes = await u.production.readEpisodeRoughCut(directory, req.query.projectId as string, req.query.taskId as string);
    res.set({ "Content-Type": "video/mp4", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).send(bytes);
  } catch (cause) { res.status(409).json(error(cause instanceof Error ? cause.message : "合成文件读取失败", null, 409)); }
});

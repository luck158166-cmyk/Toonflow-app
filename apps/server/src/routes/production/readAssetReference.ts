import { Router } from "express";
import { z } from "zod";
import { listAssetReferences } from "@toonflow/production";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error } from "@/lib/responseFormat";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096),
  projectId: z.uuid(), referenceId: z.uuid() }, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const reference = await u.production.withProduction(directory, catalog =>
    listAssetReferences(catalog, req.query.projectId as string).find(item => item.id === req.query.referenceId));
  if (!reference) return res.status(404).json(error("当前故事没有这张参考图", null, 404));
  try {
    const bytes = await u.production.readPreservedReference(directory, reference);
    res.set({ "Content-Type": reference.mimeType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).send(bytes);
  } catch { res.status(409).json(error("参考原图缺失或内容已变化，请检查工作区文件后重试", null, 409)); }
});

import { Router } from "express";
import { z } from "zod";
import { bindAssetReference, listReferenceTargets } from "@toonflow/production";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), projectId: z.uuid(),
  entityKind: z.enum(["asset", "scene"]), entityId: z.uuid(), entityHash: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.enum(["headshot", "fullBody", "scene", "prop", "costume"]), expectedReferenceId: z.uuid().nullable(),
  rightsConfirmed: z.literal(true), sourceNote: z.string().trim().min(1).max(2000),
  path: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const result = await u.production.withProduction(directory, async catalog => {
    try {
      const target = listReferenceTargets(catalog, req.body.projectId).find(item => item.entityKind === req.body.entityKind && item.entityId === req.body.entityId);
      if (!target?.locked || target.entityHash !== req.body.entityHash || !target.roles.includes(req.body.role)) {
        return { message: "资产描述未锁定、已变化或参考用途不匹配，请刷新核对" };
      }
      const file = await u.production.preserveReferenceImage(directory, req.body.path, req.body.sha256);
      return { data: bindAssetReference(catalog, { ...req.body, file }) };
    } catch (cause) { return { message: cause instanceof Error ? cause.message : "参考图绑定失败" }; }
  });
  if (result.message) return res.status(409).json(error(result.message, null, 409));
  res.json(success(result.data));
});

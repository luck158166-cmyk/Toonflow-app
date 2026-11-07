import { Router } from "express";
import { dirname } from "node:path";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";

const router = Router();

export default router.get("/", validateFields({ directory: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  if (!u.workspace.isLocalWorkspaceRequest(req)) throw Object.assign(new Error("生产备份目前仅支持本地工作区"), { status: 403 });
  const archive = await u.production.createProjectBackup(directory, dirname(u.conf.path));
  res.set("Cache-Control", "no-store").attachment("toonflowProductionBackup.zip").send(Buffer.from(archive));
});

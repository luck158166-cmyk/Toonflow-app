import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.get("/", validateFields({ directory: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  if (!u.workspace.isLocalWorkspaceRequest(req)) throw Object.assign(new Error("价格规则目前仅支持本地工作区"), { status: 403 });
  const rules = await u.production.withProduction(directory, (_catalog, store) => store.globalBudgets.listPriceRules());
  res.json(success({ rules }));
});

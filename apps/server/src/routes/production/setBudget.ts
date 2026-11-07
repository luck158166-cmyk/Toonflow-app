import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.post("/", validateFields({
  directory: z.string().min(1).max(4096),
  scopeType: z.enum(["global", "project"]),
  projectId: z.uuid().optional(),
  limitMicros: z.number().int().nonnegative().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  warningBasisPoints: z.number().int().min(1).max(10000),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) throw Object.assign(new Error("生产预算目前仅支持本地工作区"), { status: 403 });
  const { scopeType, projectId, limitMicros, currency, warningBasisPoints } = req.body;
  if (scopeType === "project" && !projectId || scopeType === "global" && projectId) {
    throw Object.assign(new Error("预算范围与故事 ID 不匹配"), { status: 400 });
  }
  const usage = await u.production.withProduction(directory, (catalog, store) => {
    if (projectId && !catalog.getStory(projectId)) {
      throw Object.assign(new Error("当前工作区没有这个故事"), { status: 404 });
    }
    const scope = { type: scopeType as "global" | "project", key: projectId ?? "*" };
    store.globalBudgets.setBudget(scope, limitMicros, currency, warningBasisPoints, "local-user");
    return store.getScopeBudgetUsage(scope);
  });
  res.json(success({ usage }));
});

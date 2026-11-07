import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.get("/", validateFields({
  directory: z.string().min(1).max(4096),
  projectId: z.uuid().optional(),
}, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  if (!u.workspace.isLocalWorkspaceRequest(req)) throw Object.assign(new Error("生产预算目前仅支持本地工作区"), { status: 403 });
  const projectId = req.query.projectId as string | undefined;
  const budget = await u.production.withProduction(directory, (catalog, store) => {
    if (projectId && !catalog.getStory(projectId)) {
      throw Object.assign(new Error("当前工作区没有这个故事"), { status: 404 });
    }
    const globalScope = { type: "global" as const, key: "*" };
    const projectScope = projectId ? { type: "project" as const, key: projectId } : null;
    return {
      global: store.getBudgetUsage(),
      globalHistory: store.globalBudgets.listBudgetHistory(globalScope),
      project: projectScope ? store.getScopeBudgetUsage(projectScope) : null,
      projectHistory: projectScope ? store.globalBudgets.listBudgetHistory(projectScope) : [],
    };
  });
  res.json(success(budget));
});

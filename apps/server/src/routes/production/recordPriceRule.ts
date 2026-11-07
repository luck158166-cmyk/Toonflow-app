import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.post("/", validateFields({
  directory: z.string().min(1).max(4096),
  provider: z.string().trim().min(1).max(96),
  modelId: z.string().trim().min(1).max(256),
  unit: z.string().trim().min(1).max(64),
  unitSize: z.number().int().positive().safe(),
  unitPriceMicros: z.number().int().nonnegative().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  sourceUrl: z.url().max(2048).refine(url => url.startsWith("https://")),
  effectiveAt: z.number().int().nonnegative().safe(),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) throw Object.assign(new Error("价格规则目前仅支持本地工作区"), { status: 403 });
  const { provider, modelId, unit, unitSize, unitPriceMicros, currency, sourceUrl, effectiveAt } = req.body;
  const rule = await u.production.withProduction(directory, (_catalog, store) => store.globalBudgets.recordPriceRule({
    provider, modelId, unit, unitSize, unitPriceMicros, currency, sourceUrl, effectiveAt, recordedBy: "local-user",
  }));
  res.status(201).json(success({ rule }));
});

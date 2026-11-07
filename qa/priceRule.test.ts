import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { GlobalBudgetCoordinator } from "../packages/production/src/globalBudgetCoordinator";

describe("confirmed production price rules", () => {
  it("quotes a fractional billing unit and keeps historical rates", () => {
    const db = new Database(":memory:");
    try {
      const budgets = new GlobalBudgetCoordinator(db);
      expect(() => budgets.quotePrice("ark", "text-model", "token", 1)).toThrow("No confirmed price rule");
      const first = budgets.recordPriceRule({ provider: "ark", modelId: "text-model", unit: "token",
        unitSize: 1_000_000, unitPriceMicros: 2_500_000, currency: "CNY",
        sourceUrl: "https://example.test/pricing", effectiveAt: 1_000, recordedBy: "local-user" });
      const second = budgets.recordPriceRule({ provider: "ark", modelId: "text-model", unit: "token",
        unitSize: 1_000_000, unitPriceMicros: 3_000_000, currency: "CNY",
        sourceUrl: "https://example.test/pricing-new", effectiveAt: 2_000, recordedBy: "local-user" });
      expect(budgets.quotePrice("ark", "text-model", "token", 12_345, 1_500)).toMatchObject({
        rule: { id: first.id }, amountMicros: 30_863, currency: "CNY",
      });
      expect(budgets.quotePrice("ark", "text-model", "token", 12_345, 2_500)).toMatchObject({
        rule: { id: second.id }, amountMicros: 37_035, currency: "CNY",
      });
      expect(db.query("SELECT COUNT(*) AS count FROM price_rule").get()).toEqual({ count: 2 });
    } finally { db.close(); }
  });

  it("rejects invalid sources and unsafe price multiplication", () => {
    const db = new Database(":memory:");
    try {
      const budgets = new GlobalBudgetCoordinator(db);
      const input = { provider: "ark", modelId: "video-model", unit: "second", unitSize: 1,
        unitPriceMicros: Number.MAX_SAFE_INTEGER, currency: "CNY", sourceUrl: "https://example.test/price",
        effectiveAt: 1, recordedBy: "local-user" };
      expect(() => budgets.recordPriceRule({ ...input, sourceUrl: "http://example.test/price" })).toThrow("HTTPS");
      budgets.recordPriceRule(input);
      expect(() => budgets.quotePrice("ark", "video-model", "second", 2)).toThrow("safe integer");
      expect(() => budgets.quotePrice("ark", "another-model", "second", 1)).toThrow("No confirmed price rule");
    } finally { db.close(); }
  });
});

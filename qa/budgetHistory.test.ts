import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { GlobalBudgetCoordinator } from "../packages/production/src/globalBudgetCoordinator";

describe("production budget change history", () => {
  it("records old and new caps for global and project scopes", () => {
    const db = new Database(":memory:");
    try {
      const budgets = new GlobalBudgetCoordinator(db);
      const global = { type: "global" as const, key: "*" };
      const project = { type: "project" as const, key: "story-a" };
      budgets.setBudget(global, 1_000_000, "CNY", 9000, "local-user");
      budgets.setBudget(global, 500_000, "CNY", 8500, "local-user");
      budgets.setBudget(project, 200_000, "CNY", 9000, "local-user");
      const globalHistory = budgets.listBudgetHistory(global);
      expect(globalHistory).toHaveLength(2);
      expect(globalHistory.find(change => change.limitMicros === 500_000)).toMatchObject({
        previousLimitMicros: 1_000_000, previousCurrency: "CNY", previousWarningBasisPoints: 9000,
        warningBasisPoints: 8500, recordedBy: "local-user",
      });
      expect(budgets.listBudgetHistory(project)).toMatchObject([{ limitMicros: 200_000, previousLimitMicros: null }]);
      expect(budgets.getGlobalUsage()).toMatchObject({ configured: true, limitMicros: 500_000 });
    } finally { db.close(); }
  });

  it("rolls back a cap change if its audit row cannot be saved", () => {
    const db = new Database(":memory:");
    try {
      const budgets = new GlobalBudgetCoordinator(db);
      const global = { type: "global" as const, key: "*" };
      budgets.setBudget(global, 1_000_000, "CNY");
      db.exec("CREATE TRIGGER reject_budget_audit BEFORE INSERT ON global_budget_change BEGIN SELECT RAISE(ABORT, 'audit write failed'); END");
      expect(() => budgets.setBudget(global, 0, "CNY")).toThrow("audit write failed");
      expect(budgets.getGlobalUsage()).toMatchObject({ limitMicros: 1_000_000 });
      expect(budgets.listBudgetHistory(global)).toHaveLength(1);
    } finally { db.close(); }
  });
});

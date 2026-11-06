import type { Database } from "bun:sqlite";
import type { BudgetScope, BudgetScopeType, ChargeDetails, Task } from "./store";

type Usage = {
  configured: boolean; scope: BudgetScope; currency: string | null; limitMicros: number;
  warningBasisPoints: number; chargedMicros: number; reservedMicros: number; usedMicros: number;
};

/** Cross-project budget authority; pass the global database separately from each project's database. */
export class GlobalBudgetCoordinator {
  constructor(readonly db: Database) {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS global_schema_migration (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS global_budget_rule (
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global','project','daily','model')),
        scope_key TEXT NOT NULL,
        limit_micros INTEGER NOT NULL CHECK (limit_micros >= 0),
        currency TEXT NOT NULL CHECK (length(currency) = 3),
        warning_basis_points INTEGER NOT NULL DEFAULT 9000 CHECK (warning_basis_points BETWEEN 1 AND 10000),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope_type, scope_key)
      );
      CREATE TABLE IF NOT EXISTS global_task_reservation (
        task_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
        currency TEXT NOT NULL CHECK (length(currency) = 3),
        state TEXT NOT NULL CHECK (state IN ('active','settled','released')),
        reserved_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS global_cost_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        source_ref TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
        currency TEXT NOT NULL CHECK (length(currency) = 3),
        usage_date TEXT NOT NULL,
        unit TEXT,
        units INTEGER CHECK (units IS NULL OR units >= 0),
        unit_price_micros INTEGER CHECK (unit_price_micros IS NULL OR unit_price_micros >= 0),
        pricing_ref TEXT,
        status TEXT NOT NULL CHECK (status IN ('reconciled','manual')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS global_cost_project_date ON global_cost_ledger(project_id, usage_date, currency);
      CREATE INDEX IF NOT EXISTS global_reservation_scope ON global_task_reservation(project_id, state, currency);
    `);
    db.query(`INSERT INTO global_schema_migration(version, applied_at) VALUES (1, ?)
      ON CONFLICT(version) DO NOTHING`).run(Date.now());
  }

  private atomic<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  setBudget(scope: BudgetScope, limitMicros: number, currency: string, warningBasisPoints = 9000) {
    if (!( ["global", "project", "daily", "model"] as BudgetScopeType[]).includes(scope.type)) {
      throw new TypeError("Episode budgets belong in the project database.");
    }
    if (!Number.isSafeInteger(limitMicros) || limitMicros < 0) throw new RangeError("Budget must be a non-negative integer in micro-units.");
    currency = currency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError("Currency must be a three-letter uppercase code.");
    if (!scope.key.trim()) throw new TypeError("Budget scope key is required.");
    if (!Number.isInteger(warningBasisPoints) || warningBasisPoints < 1 || warningBasisPoints > 10000) {
      throw new RangeError("Warning threshold must be between 1 and 10000 basis points.");
    }
    this.atomic(() => this.db.query(`INSERT INTO global_budget_rule(scope_type, scope_key, limit_micros, currency,
      warning_basis_points, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scope_type, scope_key) DO UPDATE SET
      limit_micros = excluded.limit_micros, currency = excluded.currency,
      warning_basis_points = excluded.warning_basis_points, updated_at = excluded.updated_at`)
      .run(scope.type, scope.key, limitMicros, currency, warningBasisPoints, Date.now()));
  }

  private usage(scope: BudgetScope, currency?: string): Usage {
    const rule = this.db.query(`SELECT limit_micros, currency, warning_basis_points FROM global_budget_rule
      WHERE scope_type = ? AND scope_key = ?`).get(scope.type, scope.key) as
      { limit_micros: number; currency: string; warning_basis_points: number } | null;
    if (!rule) return { configured: false, scope, currency: currency ?? null, limitMicros: 0,
      warningBasisPoints: 9000, chargedMicros: 0, reservedMicros: 0, usedMicros: 0 };
    if (currency && currency !== rule.currency) throw new Error(`Budget currency mismatch: ${currency} != ${rule.currency}`);
    const chargePredicate = scope.type === "project" ? "project_id = ?"
      : scope.type === "daily" ? "usage_date = ?"
      : scope.type === "model" ? "provider = ? AND model_id = ?" : "1 = 1";
    const reservePredicate = scope.type === "project" ? "project_id = ?"
      : scope.type === "daily" ? "date(reserved_at / 1000, 'unixepoch') = ?"
      : scope.type === "model" ? "provider = ? AND model_id = ?" : "1 = 1";
    const modelSeparator = scope.type === "model" ? scope.key.indexOf("/") : -1;
    if (scope.type === "model" && modelSeparator < 1) throw new TypeError("Model budget key must include provider/model.");
    const scopeArgs: string[] = scope.type === "model"
      ? [scope.key.slice(0, modelSeparator), scope.key.slice(modelSeparator + 1)]
      : scope.type === "global" ? [] : [scope.key];
    const charged = this.db.query(`SELECT COALESCE(SUM(amount_micros),0) AS amount FROM global_cost_ledger
      WHERE currency = ? AND ${chargePredicate}`).get(rule.currency, ...scopeArgs) as { amount: number };
    const reserved = this.db.query(`SELECT COALESCE(SUM(amount_micros),0) AS amount FROM global_task_reservation
      WHERE currency = ? AND state = 'active' AND ${reservePredicate}`).get(rule.currency, ...scopeArgs) as { amount: number };
    return { configured: true, scope, currency: rule.currency, limitMicros: rule.limit_micros,
      warningBasisPoints: rule.warning_basis_points, chargedMicros: charged.amount,
      reservedMicros: reserved.amount, usedMicros: charged.amount + reserved.amount };
  }

  getUsage(scope: BudgetScope, currency?: string) { return this.usage(scope, currency); }
  getGlobalUsage(currency?: string) { return this.usage({ type: "global", key: "*" }, currency); }

  reserve(task: Task, now = Date.now()) {
    return this.atomic(() => {
      const existing = this.db.query(`SELECT project_id, provider, model_id, amount_micros, currency, state
        FROM global_task_reservation WHERE task_id = ?`).get(task.id) as
        { project_id: string; provider: string; model_id: string; amount_micros: number; currency: string; state: string } | null;
      if (existing) {
        if (existing.project_id !== task.projectId || existing.provider !== task.provider
          || existing.model_id !== (task.modelId ?? "") || existing.amount_micros !== task.estimatedCostMicros
          || existing.currency !== task.currency || existing.state !== "active") {
          throw new Error("Task already has a non-reusable global budget reservation.");
        }
        return { allowed: true as const, created: false, warning: false,
          usedAfterReserveMicros: this.getGlobalUsage(task.currency).usedMicros };
      }
      const scopes: BudgetScope[] = [
        { type: "global", key: "*" },
        { type: "project", key: task.projectId },
        { type: "daily", key: new Date(now).toISOString().slice(0, 10) },
        ...(task.modelId ? [{ type: "model" as const, key: `${task.provider}/${task.modelId}` }] : []),
      ];
      const usages = scopes.map((scope) => this.usage(scope, task.currency));
      if (!usages[0].configured) throw new Error("Paid generation is blocked until a global budget is configured.");
      const exceeded = usages.find((usage) => usage.configured &&
        (usage.usedMicros >= usage.limitMicros || task.estimatedCostMicros > usage.limitMicros - usage.usedMicros));
      if (exceeded) return { allowed: false as const, created: false, exceeded };
      this.db.query(`INSERT INTO global_task_reservation(task_id, project_id, provider, model_id, amount_micros,
        currency, state, reserved_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
        .run(task.id, task.projectId, task.provider, task.modelId ?? "", task.estimatedCostMicros,
          task.currency, now, now);
      const globalUsage = this.getGlobalUsage(task.currency);
      const warning = usages.some((usage) => usage.configured &&
        BigInt(usage.usedMicros + task.estimatedCostMicros) * 10000n >=
        BigInt(usage.limitMicros) * BigInt(usage.warningBasisPoints));
      return { allowed: true as const, created: true, warning, usedAfterReserveMicros: globalUsage.usedMicros };
    });
  }

  private insertCharge(task: Task, sourceRef: string, amountMicros: number, currency: string,
    details: ChargeDetails, usageDate?: string) {
    const { unit, units, unitPriceMicros, pricingRef, status = "reconciled" } = details;
    const hasPricing = unit !== undefined || units !== undefined || unitPriceMicros !== undefined;
    if (hasPricing && (!unit?.trim() || units === undefined || unitPriceMicros === undefined)) {
      throw new TypeError("Unit, units, and unit price must be supplied together.");
    }
    if (units !== undefined && (!Number.isSafeInteger(units) || units < 0)) throw new RangeError("Units must be a non-negative safe integer.");
    if (unitPriceMicros !== undefined && (!Number.isSafeInteger(unitPriceMicros) || unitPriceMicros < 0)) {
      throw new RangeError("Unit price must be a non-negative integer in micro-units.");
    }
    if (units !== undefined && unitPriceMicros !== undefined && BigInt(units) * BigInt(unitPriceMicros) !== BigInt(amountMicros)) {
      throw new Error("Charge amount must equal units multiplied by unit price.");
    }
    const existing = this.db.query(`SELECT task_id, amount_micros, currency FROM global_cost_ledger WHERE source_ref = ?`)
      .get(sourceRef) as { task_id: string; amount_micros: number; currency: string } | null;
    if (existing) {
      if (existing.task_id !== task.id || existing.amount_micros !== amountMicros || existing.currency !== currency) {
        throw new Error("Global charge reference reused with different task or amount.");
      }
      return false;
    }
    this.db.query(`INSERT INTO global_cost_ledger(task_id, source_ref, project_id, provider, model_id,
      amount_micros, currency, usage_date, unit, units, unit_price_micros, pricing_ref, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.id, sourceRef, task.projectId, task.provider, task.modelId ?? "", amountMicros, currency,
        usageDate ?? new Date().toISOString().slice(0, 10), unit?.trim() ?? null, units ?? null,
        unitPriceMicros ?? null, pricingRef?.trim() ?? null, status, Date.now());
    return true;
  }

  recordCharge(task: Task, sourceRef: string, amountMicros: number, currency: string, details: ChargeDetails) {
    return this.atomic(() => this.insertCharge(task, sourceRef, amountMicros, currency, details));
  }

  settle(task: Task, sourceRef: string, amountMicros: number, currency: string, details: ChargeDetails) {
    return this.atomic(() => {
      const reservation = this.db.query(`SELECT state, reserved_at FROM global_task_reservation WHERE task_id = ?`)
        .get(task.id) as { state: string; reserved_at: number } | null;
      if (!reservation || reservation.state === "released") throw new Error("Global task reservation is missing or released.");
      const usageDate = new Date(reservation.reserved_at).toISOString().slice(0, 10);
      const inserted = this.insertCharge(task, sourceRef, amountMicros, currency, details, usageDate);
      this.db.query(`UPDATE global_task_reservation SET state = 'settled', updated_at = ? WHERE task_id = ? AND state = 'active'`)
        .run(Date.now(), task.id);
      return inserted;
    });
  }

  release(taskId: string, confirmedNoCharge: true) {
    if (confirmedNoCharge !== true) throw new Error("Global reservation release requires explicit no-charge confirmation.");
    return this.atomic(() => {
      const charge = this.db.query("SELECT 1 AS found FROM global_cost_ledger WHERE task_id = ? LIMIT 1").get(taskId);
      if (charge) throw new Error("Cannot release a global reservation after provider cost was recorded.");
      return this.db.query(`UPDATE global_task_reservation SET state = 'released', updated_at = ?
        WHERE task_id = ? AND state = 'active'`).run(Date.now(), taskId).changes > 0;
    });
  }
}

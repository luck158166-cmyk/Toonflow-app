import { createHash, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { GlobalBudgetCoordinator } from "./globalBudgetCoordinator";
import { migrateTextTaskStage } from "./taskStageMigration";

export type TaskStage = "image" | "video" | "speech" | "transcription" | "synthesis" | "text";
export type TaskState = "queued" | "dispatching" | "running" | "reconciling" | "reconcile_required" | "succeeded" | "failed" | "paused";

export type TaskInput = {
  idempotencyKey: string;
  projectId: string;
  episodeId: string;
  shotId?: string;
  stage: TaskStage;
  provider: string;
  modelId?: string;
  requestJson: string;
  estimatedCostMicros: number;
  currency: string;
  billable: boolean;
  redoneFromTaskId?: string;
};

export type Task = TaskInput & {
  id: string;
  state: TaskState;
  providerTaskId: string | null;
  redoneFromTaskId?: string;
  requestStarted: boolean;
  attempt: number;
};

export type BudgetScopeType = "global" | "project" | "episode" | "daily" | "model";
export type BudgetScope = { type: BudgetScopeType; key: string };
export const episodeBudgetKey = (projectId: string, episodeId: string) => JSON.stringify([projectId, episodeId]);
export type ChargeDetails = { unit?: string; units?: number; unitPriceMicros?: number; pricingRef?: string; status?: "reconciled" | "manual" };
export type PendingMediaDownload = {
  id: string; taskId: string; slot: string; remoteUrl: string; destinationPath: string;
  expiresAt: number; attempts: number;
};
export type FaceReferenceInput = {
  characterId: string;
  assetPath: string;
  sha256: string;
  sourceKind: "virtual_library" | "user_authorized" | "provider_generated";
  provider?: string;
  modelId?: string;
  generatedAt?: number;
  trustExpiresAt?: number;
};
export type EpisodeRenderSpec = {
  projectId: string;
  episodeId: string;
  aspectRatio: "9:16";
  width: 1080;
  height: 1920;
  videoCodec: "h264";
  audioCodec: "aac";
  clips: Array<{ shotId: string; taskId: string; slot: string; path: string; sha256: string; durationMs: number }>;
  audioTracks: Array<{ type: "dialogue" | "narration"; taskId: string; slot: string; path: string; sha256: string; startMs: number }>;
  subtitles: { path: string; sha256: string; language: string };
  bgm: { path: string; sha256: string; gainDb: number } | null;
  outputPath: string;
};
export type SynthesisExport = {
  taskId: string; projectId: string; episodeId: string; version: number;
  spec: EpisodeRenderSpec; inputSha256: string;
};

export type CreateTaskResult = { task: Task; created: boolean };
export type PricedTaskInput = Omit<TaskInput, "estimatedCostMicros" | "currency" | "billable"> & {
  unit: string; quantity: number;
};
export type TextTaskAuthorization = { approvedRequestHash: string; approvedPlanHash: string; priceRuleId: string;
  maxCalls: 1; maxCostMicros: number; currency: "CNY"; maxOutputTokens: number;
  destination: string; contextWindow: number; maxOutputTokensLimit: number };
export type MediaTaskAuthorization = { approvedRequestHash: string; approvedPlanHash: string; priceRuleId: string;
  maxCalls: 1; maxCostMicros: number; currency: "CNY"; providerRevision?: string; credentialScope?: string;
  assetTarget?: { entityKind: "asset" | "scene"; entityId: string; entityHash: string;
    role: "headshot" | "fullBody" | "scene" | "prop" | "costume"; expectedReferenceId: string | null } };
export type HostMediaBinding = { taskId: string; workspace: string; segmentKey: string;
  mediaType: "image" | "video" | "audio"; requestHash: string; authorization: MediaTaskAuthorization; launchClaimed: boolean };
export type TaskPriceSnapshot = {
  taskId: string; priceRuleId: string; unit: string; unitSize: number; unitPriceMicros: number;
  quantity: number; currency: string; estimatedCostMicros: number; sourceUrl: string; quotedAt: number;
};
export type DispatchResult =
  | { status: "started" | "warning_90"; task: Task; reservedMicros: number; usedAfterReserveMicros: number }
  | { status: "already_succeeded" | "already_dispatched" | "not_queued" | "budget_exhausted"; task: Task; usedMicros?: number; limitMicros?: number };

type TaskRow = {
  id: string; idempotency_key: string; project_id: string; episode_id: string; shot_id: string | null;
  stage: TaskStage; provider: string; model_id: string; request_json: string; estimated_cost_micros: number; currency: string;
  billable: number; redone_from_task_id: string | null; state: TaskState; provider_task_id: string | null; request_started: number; attempt: number;
};

const taskColumns = `id, idempotency_key, project_id, episode_id, shot_id, stage, provider, model_id,
  request_json, estimated_cost_micros, currency, billable, redone_from_task_id, state, provider_task_id, request_started, attempt`;

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    projectId: row.project_id,
    episodeId: row.episode_id,
    shotId: row.shot_id ?? undefined,
    stage: row.stage,
    provider: row.provider,
    modelId: row.model_id || undefined,
    requestJson: row.request_json,
    estimatedCostMicros: row.estimated_cost_micros,
    currency: row.currency,
    billable: row.billable === 1,
    state: row.state,
    providerTaskId: row.provider_task_id,
    redoneFromTaskId: row.redone_from_task_id ?? undefined,
    requestStarted: row.request_started === 1,
    attempt: row.attempt,
  };
}

function assertMoney(value: number, currency: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Money must be a non-negative integer in micro-units.");
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError("Currency must be a three-letter uppercase code.");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function serializeHostMediaRequest(value: unknown) { return stableJson(value); }

function assertWorkspaceRelativePath(value: string) {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized.trim() || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)
    || normalized.split("/").some((part) => part === ".." || part === ".")
    || normalized.includes(String.fromCharCode(0))) {
    throw new TypeError("Media paths must stay within the project workspace.");
  }
}

function artifactPathKey(value: string) {
  assertWorkspaceRelativePath(value);
  const parts = value.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.some(part => /[\x00-\x1f:<>"|?*]|[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new TypeError("Media path is not a valid Windows workspace path.");
  }
  return parts.join("/").toLowerCase();
}

export class ProductionStore {
  readonly globalBudgets: GlobalBudgetCoordinator;

  private assertArtifactPathAvailable(taskId: string, slot: string, path: string) {
    const key = artifactPathKey(path);
    const owners = this.db.query(`SELECT task_id, slot, path FROM media_output
      UNION ALL SELECT task_id, slot, destination_path AS path FROM media_download
      UNION ALL SELECT task_id, 'episode' AS slot, destination_path AS path FROM synthesis_export`)
      .all() as Array<{ task_id: string; slot: string; path: string }>;
    if (owners.some(owner => artifactPathKey(owner.path) === key
      && (owner.task_id !== taskId || owner.slot !== slot))) {
      throw new Error("Artifact path is already owned by another output; use a unique path.");
    }
  }

  constructor(readonly db: Database) {
    this.globalBudgets = new GlobalBudgetCoordinator(db);
    db.exec("PRAGMA foreign_keys = ON;");
    db.query("PRAGMA journal_mode = WAL").get();
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS budget_rule (
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global','project','episode','daily','model')),
        scope_key TEXT NOT NULL,
        limit_micros INTEGER NOT NULL CHECK (limit_micros >= 0),
        currency TEXT NOT NULL CHECK (length(currency) = 3),
        warning_basis_points INTEGER NOT NULL DEFAULT 9000 CHECK (warning_basis_points BETWEEN 1 AND 10000),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope_type, scope_key)
      );
      CREATE TABLE IF NOT EXISTS generation_task (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        shot_id TEXT,
        stage TEXT NOT NULL CHECK (stage IN ('image','video','speech','transcription','synthesis','text')),
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL DEFAULT '',
        request_json TEXT NOT NULL,
        estimated_cost_micros INTEGER NOT NULL CHECK (estimated_cost_micros >= 0),
        currency TEXT NOT NULL CHECK (length(currency) = 3),
        billable INTEGER NOT NULL CHECK (billable IN (0,1)),
        redone_from_task_id TEXT REFERENCES generation_task(id),
        state TEXT NOT NULL CHECK (state IN ('queued','dispatching','running','reconciling','reconcile_required','succeeded','failed','paused')),
        provider_task_id TEXT,
        request_started INTEGER NOT NULL DEFAULT 0 CHECK (request_started IN (0,1)),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_price_snapshot (
        task_id TEXT PRIMARY KEY REFERENCES generation_task(id),
        price_rule_id TEXT NOT NULL REFERENCES price_rule(id),
        unit TEXT NOT NULL,
        unit_size INTEGER NOT NULL CHECK (unit_size > 0),
        unit_price_micros INTEGER NOT NULL CHECK (unit_price_micros >= 0),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        currency TEXT NOT NULL CHECK (length(currency) = 3),
        estimated_cost_micros INTEGER NOT NULL CHECK (estimated_cost_micros > 0),
        source_url TEXT NOT NULL,
        quoted_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS generation_task_provider_id
        ON generation_task(provider, provider_task_id) WHERE provider_task_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS task_reservation (
        task_id TEXT PRIMARY KEY REFERENCES generation_task(id),
        amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
        currency TEXT NOT NULL CHECK (length(currency) = 3),
        state TEXT NOT NULL CHECK (state IN ('active','settled','released')),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cost_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES generation_task(id),
        source_ref TEXT NOT NULL UNIQUE,
        amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
        currency TEXT NOT NULL CHECK (length(currency) = 3),
        unit TEXT,
        units INTEGER CHECK (units IS NULL OR units >= 0),
        unit_price_micros INTEGER CHECK (unit_price_micros IS NULL OR unit_price_micros >= 0),
        pricing_ref TEXT,
        status TEXT NOT NULL DEFAULT 'reconciled' CHECK (status IN ('reconciled','manual')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media_output (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES generation_task(id),
        slot TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        created_at INTEGER NOT NULL,
        UNIQUE (task_id, slot)
      );
      CREATE TABLE IF NOT EXISTS synthesis_version (
        project_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        latest_version INTEGER NOT NULL CHECK (latest_version >= 0),
        PRIMARY KEY (project_id, episode_id)
      );
      CREATE TABLE IF NOT EXISTS synthesis_export (
        task_id TEXT PRIMARY KEY REFERENCES generation_task(id),
        project_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        destination_path TEXT NOT NULL UNIQUE,
        spec_json TEXT NOT NULL,
        input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
        created_at INTEGER NOT NULL,
        UNIQUE (project_id, episode_id, version)
      );
      CREATE TABLE IF NOT EXISTS media_download (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES generation_task(id),
        slot TEXT NOT NULL,
        remote_url TEXT NOT NULL,
        destination_path TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','downloading','failed','downloaded','expired')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at INTEGER NOT NULL,
        sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
        last_error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (task_id, slot)
      );
      CREATE TABLE IF NOT EXISTS face_reference (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        asset_path TEXT NOT NULL,
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('virtual_library','user_authorized','provider_generated')),
        provider TEXT,
        model_id TEXT,
        generated_at INTEGER,
        trust_expires_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('active','superseded','revoked')),
        supersedes_id TEXT REFERENCES face_reference(id),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS face_reference_character ON face_reference(character_id, status, trust_expires_at);
      CREATE INDEX IF NOT EXISTS generation_task_recovery
        ON generation_task(state, request_started, provider_task_id);
    `);
    migrateTextTaskStage(db);
    db.exec(`CREATE TABLE IF NOT EXISTS text_output (
      task_id TEXT PRIMARY KEY REFERENCES generation_task(id),
      response_text TEXT NOT NULL, response_sha256 TEXT NOT NULL,
      provider_request_id TEXT NOT NULL, usage_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS text_task_authorization (
      task_id TEXT PRIMARY KEY REFERENCES generation_task(id), authorization_json TEXT NOT NULL,
      max_calls INTEGER NOT NULL CHECK(max_calls = 1), created_at INTEGER NOT NULL
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS host_media_binding (
      task_id TEXT PRIMARY KEY REFERENCES generation_task(id), workspace TEXT NOT NULL,
      segment_key TEXT NOT NULL, media_type TEXT NOT NULL CHECK(media_type IN ('image','video','audio')),
      request_hash TEXT NOT NULL, authorization_json TEXT NOT NULL,
      launch_claimed INTEGER NOT NULL DEFAULT 0 CHECK(launch_claimed IN (0,1)), created_at INTEGER NOT NULL
    );`);
    db.query("INSERT INTO schema_migration(version, applied_at) VALUES (1, ?) ON CONFLICT(version) DO NOTHING")
      .run(Date.now());
    db.query("INSERT INTO schema_migration(version, applied_at) VALUES (2, ?) ON CONFLICT(version) DO NOTHING")
      .run(Date.now());
    db.query("INSERT INTO schema_migration(version, applied_at) VALUES (3, ?) ON CONFLICT(version) DO NOTHING")
      .run(Date.now());
    db.query("INSERT INTO schema_migration(version, applied_at) VALUES (4, ?) ON CONFLICT(version) DO NOTHING")
      .run(Date.now());
  }

  private atomic<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private row(id: string): TaskRow {
    const row = this.db.query(`SELECT ${taskColumns} FROM generation_task WHERE id = ?`).get(id) as TaskRow | null;
    if (!row) throw new Error(`Unknown generation task: ${id}`);
    return row;
  }

  getTask(id: string): Task {
    return toTask(this.row(id));
  }

  getTaskPriceSnapshot(taskId: string): TaskPriceSnapshot | null {
    return this.db.query(`SELECT task_id AS taskId, price_rule_id AS priceRuleId, unit,
      unit_size AS unitSize, unit_price_micros AS unitPriceMicros, quantity, currency,
      estimated_cost_micros AS estimatedCostMicros, source_url AS sourceUrl, quoted_at AS quotedAt
      FROM task_price_snapshot WHERE task_id = ?`).get(taskId) as TaskPriceSnapshot | null;
  }

  setBudget(limitMicros: number, currency: string) {
    this.setScopeBudget({ type: "global", key: "*" }, limitMicros, currency);
  }

  setScopeBudget(scope: BudgetScope, limitMicros: number, currency: string, warningBasisPoints = 9000) {
    currency = currency.toUpperCase();
    assertMoney(limitMicros, currency);
    if (!scope.key.trim()) throw new TypeError("Budget scope key is required.");
    if (!Number.isInteger(warningBasisPoints) || warningBasisPoints < 1 || warningBasisPoints > 10000) {
      throw new RangeError("Warning threshold must be between 1 and 10000 basis points.");
    }
    if (scope.type !== "episode") {
      this.globalBudgets.setBudget(scope, limitMicros, currency, warningBasisPoints);
      return;
    }
    this.atomic(() => this.db.query(`INSERT INTO budget_rule(scope_type, scope_key, limit_micros, currency, warning_basis_points, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scope_type, scope_key) DO UPDATE SET
      limit_micros = excluded.limit_micros, currency = excluded.currency,
      warning_basis_points = excluded.warning_basis_points, updated_at = excluded.updated_at`)
      .run(scope.type, scope.key, limitMicros, currency, warningBasisPoints, Date.now()));
  }

  createTask(input: TaskInput): CreateTaskResult {
    return this.atomic(() => this.createTaskInTransaction(input));
  }

  /** Create a new paid task, reserve its budget, and persist dispatch intent in one transaction. */
  createTaskAndBeginSubmission(input: TaskInput): DispatchResult {
    return this.atomic(() => {
      const created = this.createTaskInTransaction(input);
      return this.beginSubmissionInTransaction(created.task.id);
    });
  }

  /** New priced submissions freeze the confirmed rate, quote, and budget reservation together. */
  createPricedTaskAndBeginSubmission(input: PricedTaskInput, authorization?: TextTaskAuthorization): DispatchResult {
    return this.atomic(() => this.createPricedTaskInTransaction(input, authorization));
  }

  private createPricedTaskInTransaction(input: PricedTaskInput, authorization?: TextTaskAuthorization): DispatchResult {
    if (input.stage === "text" && (!authorization || authorization.currency !== "CNY"
      || authorization.maxCalls !== 1 || !/^[a-f0-9]{64}$/.test(authorization.approvedPlanHash)
      || !authorization.priceRuleId?.trim()
      || !authorization.destination?.trim() || authorization.destination.length > 4096
      || !Number.isSafeInteger(authorization.contextWindow) || authorization.contextWindow < 1
      || !Number.isSafeInteger(authorization.maxOutputTokensLimit) || authorization.maxOutputTokensLimit < authorization.maxOutputTokens
      || !Number.isSafeInteger(authorization.maxCostMicros) || authorization.maxCostMicros < 1
      || !Number.isSafeInteger(authorization.maxOutputTokens) || authorization.maxOutputTokens < 1
      || authorization.approvedRequestHash !== createHash("sha256").update(input.requestJson).digest("hex"))) {
      throw new Error("编剧调用必须明确授权本次输入、一次调用和人民币上限");
    }
    const modelId = input.modelId?.trim() ?? "";
    if (!modelId || !input.unit.trim() || !Number.isSafeInteger(input.quantity) || input.quantity < 1) {
      throw new TypeError("Priced tasks require a model, billing unit, and positive safe-integer quantity.");
    }
    if (input.stage === "synthesis") throw new TypeError("Local synthesis is not a paid model task.");
    {
      const { unit, quantity, ...taskInput } = input;
      const billingUnit = unit.trim();
      const old = this.db.query(`SELECT ${taskColumns} FROM generation_task WHERE idempotency_key = ?`)
        .get(input.idempotencyKey) as TaskRow | null;
      if (old) {
        if (input.stage === "text") {
          const saved = this.db.query("SELECT authorization_json AS value FROM text_task_authorization WHERE task_id = ?").get(old.id) as { value: string } | null;
          if (!saved || stableJson(JSON.parse(saved.value)) !== stableJson(authorization)) throw new Error("本次授权与已保存任务不一致");
        }
        const snapshot = this.getTaskPriceSnapshot(old.id);
        if (!snapshot || snapshot.unit !== billingUnit || snapshot.quantity !== quantity) {
          throw new Error("Idempotency key reused for a different price request.");
        }
        const created = this.createTaskInTransaction({ ...taskInput,
          estimatedCostMicros: snapshot.estimatedCostMicros, currency: snapshot.currency, billable: true });
        return this.beginSubmissionInTransaction(created.task.id);
      }
      const quotedAt = Date.now();
      const quote = this.globalBudgets.quotePrice(input.provider, modelId, billingUnit, quantity, quotedAt);
      if (input.stage === "text" && quote.rule.id !== authorization!.priceRuleId) throw new Error("价格已变更，请重新检查费用并授权");
      if (input.stage === "text" && (quote.currency !== authorization!.currency || quote.amountMicros > authorization!.maxCostMicros)) {
        throw new Error("编剧费用预估超过本次人民币授权上限");
      }
      if (quote.amountMicros < 1) throw new Error("Paid model task requires a positive confirmed price.");
      const created = this.createTaskInTransaction({ ...taskInput,
        estimatedCostMicros: quote.amountMicros, currency: quote.currency, billable: true });
      if (input.stage === "text") this.db.query(`INSERT INTO text_task_authorization(task_id, authorization_json, max_calls, created_at)
        VALUES (?, ?, 1, ?)`).run(created.task.id, JSON.stringify(authorization), Date.now());
      this.db.query(`INSERT INTO task_price_snapshot(task_id, price_rule_id, unit, unit_size,
        unit_price_micros, quantity, currency, estimated_cost_micros, source_url, quoted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(created.task.id, quote.rule.id, billingUnit,
          quote.rule.unitSize, quote.rule.unitPriceMicros, quantity, quote.currency,
          quote.amountMicros, quote.rule.sourceUrl, quotedAt);
      return this.beginSubmissionInTransaction(created.task.id);
    }
  }

  /** Called only after server-side readiness checks. Native UUID equals the production task UUID. */
  createHostMediaTask(input: PricedTaskInput, binding: Omit<HostMediaBinding, "taskId" | "launchClaimed" | "requestHash">) {
    const { authorization } = binding;
    const requestHash = createHash("sha256").update(input.requestJson).digest("hex");
    if (!binding.workspace.trim() || !binding.segmentKey.trim()
      || ({ image: "image", video: "video", audio: "speech" } as const)[binding.mediaType] !== input.stage
      || authorization.approvedRequestHash !== requestHash || !/^[a-f0-9]{64}$/.test(authorization.approvedPlanHash)
      || authorization.currency !== "CNY" || authorization.maxCalls !== 1 || !authorization.priceRuleId.trim()
      || (authorization.providerRevision !== undefined && !/^[a-f0-9]{64}$/.test(authorization.providerRevision))
      || (authorization.credentialScope !== undefined && !/^[a-f0-9]{64}$/.test(authorization.credentialScope))
      || !Number.isSafeInteger(authorization.maxCostMicros) || authorization.maxCostMicros < 1) {
      throw new Error("媒体任务必须绑定工作区、片段、完整请求、方案及一次调用的人民币授权");
    }
    return this.atomic(() => {
      const old = this.findTaskByIdempotencyKey(input.idempotencyKey);
      const saved = old && this.getHostMediaBinding(old.id);
      if (old && (!saved || saved.workspace !== binding.workspace || saved.segmentKey !== binding.segmentKey
        || saved.mediaType !== binding.mediaType || stableJson(saved.authorization) !== stableJson(authorization))) {
        throw new Error("同一媒体任务不能改用其他工作区、片段或授权");
      }
      const dispatch = this.createPricedTaskInTransaction(input);
      const price = this.getTaskPriceSnapshot(dispatch.task.id)!;
      if (price.priceRuleId !== authorization.priceRuleId || price.currency !== "CNY" || price.estimatedCostMicros > authorization.maxCostMicros) {
        throw new Error("媒体费用或价格规则已变化，请重新检查并授权");
      }
      // Unlike a passive warning, media production must stop before crossing the configured threshold.
      if (dispatch.status === "warning_90") throw new Error("本次媒体任务将达到预算预警线，尚未提交；请先调整预算或生产计划");
      if (!saved) this.db.query(`INSERT INTO host_media_binding(task_id, workspace, segment_key, media_type,
        request_hash, authorization_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(dispatch.task.id, binding.workspace, binding.segmentKey, binding.mediaType, requestHash, JSON.stringify(authorization), Date.now());
      return { ...dispatch, binding: this.getHostMediaBinding(dispatch.task.id)! };
    });
  }

  getHostMediaBinding(taskId: string): HostMediaBinding | null {
    const row = this.db.query(`SELECT task_id AS taskId, workspace, segment_key AS segmentKey, media_type AS mediaType,
      request_hash AS requestHash, authorization_json AS authorizationJson, launch_claimed AS launchClaimed
      FROM host_media_binding WHERE task_id = ?`).get(taskId) as
      (Omit<HostMediaBinding, "authorization" | "launchClaimed"> & { authorizationJson: string; launchClaimed: number }) | null;
    if (!row) return null;
    const { authorizationJson, launchClaimed, ...rest } = row;
    return { ...rest, launchClaimed: !!launchClaimed, authorization: JSON.parse(authorizationJson) };
  }

  assertHostMediaSubmission(taskId: string, workspace: string, mediaType: HostMediaBinding["mediaType"], requestJson: string) {
    const binding = this.getHostMediaBinding(taskId); const task = this.getTask(taskId);
    const reservation = this.db.query("SELECT amount_micros AS amount, currency, state FROM task_reservation WHERE task_id = ?")
      .get(taskId) as { amount: number; currency: string; state: string } | null;
    if (!binding || binding.workspace !== workspace || binding.mediaType !== mediaType
      || binding.requestHash !== createHash("sha256").update(requestJson).digest("hex") || task.requestJson !== requestJson
      || task.state !== "dispatching" || !task.requestStarted || task.attempt !== 1
      || !reservation || reservation.state !== "active" || reservation.amount !== task.estimatedCostMicros
      || reservation.currency !== "CNY" || reservation.amount > binding.authorization.maxCostMicros) {
      throw new Error("缺少与当前媒体请求一致的生产归属、授权或有效预算预留");
    }
    return binding;
  }

  claimHostMediaLaunch(taskId: string, workspace: string, mediaType: HostMediaBinding["mediaType"], requestJson: string) {
    return this.atomic(() => {
      const binding = this.getHostMediaBinding(taskId);
      if (binding?.launchClaimed) return false;
      this.assertHostMediaSubmission(taskId, workspace, mediaType, requestJson);
      this.db.query("UPDATE host_media_binding SET launch_claimed = 1 WHERE task_id = ?").run(taskId);
      return true;
    });
  }

  private createTaskInTransaction(input: TaskInput): CreateTaskResult {
    const currency = input.currency.toUpperCase();
    assertMoney(input.estimatedCostMicros, currency);
    if (!input.idempotencyKey.trim() || !input.projectId.trim() || !input.episodeId.trim() || !input.provider.trim()) {
      throw new TypeError("Task identity, project, episode, and provider are required.");
    }
    const normalized = { ...input, currency, modelId: input.modelId?.trim() ?? "" };
    const old = this.db.query(`SELECT ${taskColumns} FROM generation_task WHERE idempotency_key = ?`)
      .get(normalized.idempotencyKey) as TaskRow | null;
    if (old) {
      const same = old.project_id === normalized.projectId && old.episode_id === normalized.episodeId
        && old.shot_id === (normalized.shotId ?? null) && old.stage === normalized.stage
        && old.provider === normalized.provider && old.model_id === normalized.modelId && old.request_json === normalized.requestJson
        && old.estimated_cost_micros === normalized.estimatedCostMicros && old.currency === normalized.currency
        && (old.billable === 1) === normalized.billable && old.redone_from_task_id === (normalized.redoneFromTaskId ?? null);
      if (!same) throw new Error("Idempotency key reused for a different request.");
      return { task: toTask(old), created: false };
    }
    const id = randomUUID();
    const now = Date.now();
    this.db.query(`INSERT INTO generation_task (${taskColumns}, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, 0, 0, ?, ?)`)
      .run(id, normalized.idempotencyKey, normalized.projectId, normalized.episodeId, normalized.shotId ?? null,
        normalized.stage, normalized.provider, normalized.modelId, normalized.requestJson, normalized.estimatedCostMicros,
        normalized.currency, normalized.billable ? 1 : 0, normalized.redoneFromTaskId ?? null, now, now);
    return { task: this.getTask(id), created: true };
  }

  createRedoTask(originalTaskId: string, idempotencyKey: string, requestJson: string, estimatedCostMicros: number): CreateTaskResult {
    const original = this.row(originalTaskId);
    if (!["succeeded", "failed"].includes(original.state)) {
      throw new Error("Only a completed or failed clip can be redone; reconcile in-flight work first.");
    }
    if (!idempotencyKey.trim() || idempotencyKey === original.idempotency_key) {
      throw new Error("A redo must use a new idempotency key.");
    }
    return this.createTask({
      idempotencyKey,
      projectId: original.project_id,
      episodeId: original.episode_id,
      shotId: original.shot_id ?? undefined,
      stage: original.stage,
      provider: original.provider,
      modelId: original.model_id || undefined,
      requestJson,
      estimatedCostMicros,
      currency: original.currency,
      billable: original.billable === 1,
      redoneFromTaskId: originalTaskId,
    });
  }

  private usageFor(scope: BudgetScope, currency?: string) {
    if (scope.type !== "episode") return this.globalBudgets.getUsage(scope, currency);
    const rule = this.db.query(`SELECT limit_micros, currency, warning_basis_points FROM budget_rule
      WHERE scope_type = ? AND scope_key = ?`).get(scope.type, scope.key) as
      { limit_micros: number; currency: string; warning_basis_points: number } | null;
    if (!rule) return { configured: false, scope, currency: currency ?? null, limitMicros: 0,
      warningBasisPoints: 9000, chargedMicros: 0, reservedMicros: 0, usedMicros: 0 };
    if (currency && currency !== rule.currency) throw new Error(`Budget currency mismatch: ${currency} != ${rule.currency}`);
    const [projectId, episodeId] = JSON.parse(scope.key) as [string, string];
    const charged = this.db.query(`SELECT COALESCE(SUM(c.amount_micros),0) AS amount FROM cost_ledger c
      JOIN generation_task t ON t.id = c.task_id WHERE c.currency = ? AND t.project_id = ? AND t.episode_id = ?`)
      .get(rule.currency, projectId, episodeId) as { amount: number };
    const reserved = this.db.query(`SELECT COALESCE(SUM(r.amount_micros),0) AS amount FROM task_reservation r
      JOIN generation_task t ON t.id = r.task_id WHERE r.currency = ? AND r.state = 'active'
      AND t.project_id = ? AND t.episode_id = ?`)
      .get(rule.currency, projectId, episodeId) as { amount: number };
    return { configured: true, scope, currency: rule.currency, limitMicros: rule.limit_micros,
      warningBasisPoints: rule.warning_basis_points, chargedMicros: charged.amount,
      reservedMicros: reserved.amount, usedMicros: charged.amount + reserved.amount };
  }

  getScopeBudgetUsage(scope: BudgetScope, currency?: string) {
    return this.usageFor(scope, currency);
  }

  getBudgetUsage(currency?: string) {
    return this.globalBudgets.getGlobalUsage(currency);
  }

  createSynthesisTask(idempotencyKey: string, spec: EpisodeRenderSpec) {
    if (!idempotencyKey.trim() || !spec.projectId.trim() || !spec.episodeId.trim()) {
      throw new TypeError("Project, episode, and idempotency key are required for synthesis.");
    }
    if (spec.aspectRatio !== "9:16" || spec.width !== 1080 || spec.height !== 1920
      || spec.videoCodec !== "h264" || spec.audioCodec !== "aac") {
      throw new TypeError("Synthesis output must be portrait 1080×1920 H.264/AAC.");
    }
    if (!Array.isArray(spec.clips) || spec.clips.length === 0) throw new TypeError("At least one completed clip is required.");
    const shotIds = new Set<string>();
    const inputPaths = new Set<string>();
    for (const clip of spec.clips) {
      if (!clip.shotId.trim() || shotIds.has(clip.shotId) || !Number.isSafeInteger(clip.durationMs)
        || clip.durationMs < 1 || !/^[a-f0-9]{64}$/i.test(clip.sha256)) {
        throw new TypeError("Each clip needs a unique shot, duration, and SHA-256.");
      }
      shotIds.add(clip.shotId);
      assertWorkspaceRelativePath(clip.path);
      inputPaths.add(artifactPathKey(clip.path));
      const source = this.db.query(`SELECT o.path, o.sha256 FROM media_output o
        JOIN generation_task t ON t.id = o.task_id WHERE o.task_id = ? AND o.slot = ?
        AND t.project_id = ? AND t.episode_id = ? AND t.shot_id = ? AND t.state = 'succeeded'`)
        .get(clip.taskId, clip.slot, spec.projectId, spec.episodeId, clip.shotId) as { path: string; sha256: string } | null;
      if (!source || source.path !== clip.path || source.sha256 !== clip.sha256.toLowerCase()) {
        throw new Error(`Clip input is missing or changed for shot ${clip.shotId}.`);
      }
    }
    for (const track of spec.audioTracks) {
      if (!Number.isSafeInteger(track.startMs) || track.startMs < 0 || !/^[a-f0-9]{64}$/i.test(track.sha256)) {
        throw new TypeError("Audio tracks need a non-negative start time and SHA-256.");
      }
      assertWorkspaceRelativePath(track.path);
      inputPaths.add(artifactPathKey(track.path));
      const source = this.db.query(`SELECT o.path, o.sha256 FROM media_output o
        JOIN generation_task t ON t.id = o.task_id WHERE o.task_id = ? AND o.slot = ?
        AND t.project_id = ? AND t.episode_id = ? AND t.state = 'succeeded' AND t.stage = 'speech'`)
        .get(track.taskId, track.slot, spec.projectId, spec.episodeId) as { path: string; sha256: string } | null;
      if (!source || source.path !== track.path || source.sha256 !== track.sha256.toLowerCase()) {
        throw new Error(`Audio input is missing or changed: ${track.path}.`);
      }
    }
    assertWorkspaceRelativePath(spec.subtitles.path);
    if (!/^[a-f0-9]{64}$/i.test(spec.subtitles.sha256) || !spec.subtitles.language.trim()) {
      throw new TypeError("Subtitle input needs a language and SHA-256.");
    }
    inputPaths.add(artifactPathKey(spec.subtitles.path));
    if (spec.bgm) {
      assertWorkspaceRelativePath(spec.bgm.path);
      if (!/^[a-f0-9]{64}$/i.test(spec.bgm.sha256) || !Number.isFinite(spec.bgm.gainDb)
        || spec.bgm.gainDb < -60 || spec.bgm.gainDb > 12) throw new TypeError("BGM path, hash, or gain is invalid.");
      inputPaths.add(artifactPathKey(spec.bgm.path));
    }
    assertWorkspaceRelativePath(spec.outputPath);
    if (inputPaths.has(artifactPathKey(spec.outputPath))) throw new Error("Synthesis output cannot overwrite one of its inputs.");

    const normalizedSpec = JSON.parse(stableJson(spec)) as EpisodeRenderSpec;
    const requestJson = stableJson(normalizedSpec);
    const result = this.createTask({ idempotencyKey, projectId: spec.projectId, episodeId: spec.episodeId,
      stage: "synthesis", provider: "local-synth", modelId: "ffmpeg-local", requestJson,
      estimatedCostMicros: 0, currency: "CNY", billable: false });
    const inputSha256 = createHash("sha256").update(requestJson).digest("hex");
    if (!result.created) {
      const existing = this.getSynthesisExport(result.task.id);
      if (!existing || existing.inputSha256 !== inputSha256) throw new Error("Synthesis idempotency key was reused for a different render.");
      return { ...result, export: existing };
    }
    const renderExport = this.atomic(() => {
      this.assertArtifactPathAvailable(result.task.id, "episode", spec.outputPath);
      const existingPath = this.db.query(`SELECT 1 AS found FROM media_output WHERE path = ?
        UNION SELECT 1 AS found FROM synthesis_export WHERE destination_path = ? LIMIT 1`)
        .get(spec.outputPath, spec.outputPath);
      if (existingPath) throw new Error("Synthesis output path must be unique to preserve prior exports.");
      const versionRow = this.db.query(`SELECT latest_version FROM synthesis_version WHERE project_id = ? AND episode_id = ?`)
        .get(spec.projectId, spec.episodeId) as { latest_version: number } | null;
      const version = (versionRow?.latest_version ?? 0) + 1;
      this.db.query(`INSERT INTO synthesis_version(project_id, episode_id, latest_version) VALUES (?, ?, ?)
        ON CONFLICT(project_id, episode_id) DO UPDATE SET latest_version = excluded.latest_version`)
        .run(spec.projectId, spec.episodeId, version);
      this.db.query(`INSERT INTO synthesis_export(task_id, project_id, episode_id, version, destination_path,
        spec_json, input_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(result.task.id, spec.projectId, spec.episodeId, version, spec.outputPath, requestJson, inputSha256, Date.now());
      return { taskId: result.task.id, projectId: spec.projectId, episodeId: spec.episodeId, version,
        spec: normalizedSpec, inputSha256 } satisfies SynthesisExport;
    });
    return { ...result, export: renderExport };
  }

  getSynthesisExport(taskId: string): SynthesisExport | null {
    const row = this.db.query(`SELECT task_id, project_id, episode_id, version, spec_json, input_sha256
      FROM synthesis_export WHERE task_id = ?`).get(taskId) as {
        task_id: string; project_id: string; episode_id: string; version: number; spec_json: string; input_sha256: string;
      } | null;
    if (!row) return null;
    return { taskId: row.task_id, projectId: row.project_id, episodeId: row.episode_id, version: row.version,
      spec: JSON.parse(row.spec_json) as EpisodeRenderSpec, inputSha256: row.input_sha256 };
  }

  getEpisodeCostBreakdown(projectId: string, episodeId: string) {
    if (!projectId.trim() || !episodeId.trim()) throw new TypeError("Project and episode IDs are required.");
    return this.db.query(`SELECT t.shot_id AS shotId, t.stage, t.provider, t.model_id AS modelId, t.currency,
      COALESCE(SUM(c.amount_micros), 0) AS chargedMicros,
      COALESCE((SELECT SUM(r.amount_micros) FROM task_reservation r
        WHERE r.task_id = t.id AND r.state = 'active'), 0) AS reservedMicros
      FROM generation_task t LEFT JOIN cost_ledger c ON c.task_id = t.id
      WHERE t.project_id = ? AND t.episode_id = ?
      GROUP BY t.id ORDER BY t.created_at, t.id`).all(projectId, episodeId) as Array<{
        shotId: string | null; stage: TaskStage; provider: string; modelId: string; currency: string;
        chargedMicros: number; reservedMicros: number;
      }>;
  }

  listEpisodeCharges(projectId: string, episodeId: string) {
    if (!projectId.trim() || !episodeId.trim()) throw new TypeError("Project and episode IDs are required.");
    return this.db.query(`SELECT c.task_id AS taskId, t.shot_id AS shotId, t.stage,
      t.provider, t.model_id AS modelId, c.source_ref AS sourceRef,
      c.amount_micros AS amountMicros, c.currency, c.status, c.pricing_ref AS pricingRef,
      c.unit, c.units, c.unit_price_micros AS unitPriceMicros, c.created_at AS createdAt
      FROM cost_ledger c JOIN generation_task t ON t.id = c.task_id
      WHERE t.project_id = ? AND t.episode_id = ? ORDER BY c.created_at, c.id`)
      .all(projectId, episodeId) as Array<{ taskId: string; shotId: string | null; stage: TaskStage;
        provider: string; modelId: string; sourceRef: string; amountMicros: number; currency: string;
        status: "reconciled" | "manual"; pricingRef: string | null; unit: string | null;
        units: number | null; unitPriceMicros: number | null; createdAt: number }>;
  }

  listProjectTasks(projectId: string) {
    if (!projectId.trim()) throw new TypeError("Project ID is required.");
    return this.db.query(`SELECT t.id, t.episode_id AS episodeId, t.shot_id AS shotId, t.stage,
      t.provider, t.model_id AS modelId, t.state, t.billable,
      t.estimated_cost_micros AS estimatedCostMicros, t.currency,
      COALESCE(r.amount_micros, 0) AS reservedMicros,
      COALESCE((SELECT SUM(c.amount_micros) FROM cost_ledger c WHERE c.task_id = t.id), 0) AS chargedMicros,
      ((SELECT COUNT(*) FROM media_output o WHERE o.task_id = t.id)
        + (SELECT COUNT(*) FROM text_output x WHERE x.task_id = t.id)) AS outputCount,
      t.created_at AS createdAt, t.updated_at AS updatedAt
      , h.segment_key AS segmentKey, h.task_id AS hostTaskId
      FROM generation_task t LEFT JOIN task_reservation r ON r.task_id = t.id AND r.state = 'active'
      LEFT JOIN host_media_binding h ON h.task_id = t.id
      WHERE t.project_id = ? ORDER BY t.created_at DESC, t.id DESC`).all(projectId) as Array<{
        id: string; episodeId: string; shotId: string | null; stage: TaskStage; provider: string;
        modelId: string; state: TaskState; billable: number; estimatedCostMicros: number;
        currency: string; reservedMicros: number; chargedMicros: number; outputCount: number;
        createdAt: number; updatedAt: number; segmentKey: string | null; hostTaskId: string | null }>;
  }

  enqueueMediaDownload(taskId: string, slot: string, remoteUrl: string, destinationPath: string,
    expiresAt: number, now = Date.now()) {
    if (!slot.trim() || !destinationPath.trim()) throw new TypeError("Download slot and destination path are required.");
    let parsedUrl: URL;
    try { parsedUrl = new URL(remoteUrl); } catch { throw new TypeError("Remote media URL is invalid."); }
    if (parsedUrl.protocol !== "https:") throw new TypeError("Provider media URL must use HTTPS.");
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new RangeError("Media URL must have a future expiration time.");
    return this.atomic(() => {
      this.row(taskId);
      this.assertArtifactPathAvailable(taskId, slot, destinationPath);
      const existing = this.db.query(`SELECT id, task_id AS taskId, slot, remote_url AS remoteUrl,
        destination_path AS destinationPath, expires_at AS expiresAt, attempts
        FROM media_download WHERE task_id = ? AND slot = ?`).get(taskId, slot) as PendingMediaDownload | null;
      if (existing) {
        if (existing.remoteUrl !== remoteUrl || existing.destinationPath !== destinationPath || existing.expiresAt !== expiresAt) {
          throw new Error("A download slot already tracks a different provider artifact.");
        }
        return existing;
      }
      const id = randomUUID();
      this.db.query(`INSERT INTO media_download(id, task_id, slot, remote_url, destination_path, expires_at,
        state, attempts, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`)
        .run(id, taskId, slot, remoteUrl, destinationPath, expiresAt, now, now, now);
      return { id, taskId, slot, remoteUrl, destinationPath, expiresAt, attempts: 0 };
    });
  }

  claimDueMediaDownloads(now = Date.now(), limit = 10): PendingMediaDownload[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Download batch size must be between 1 and 100.");
    return this.atomic(() => {
      this.db.query(`UPDATE media_download SET state = 'expired', updated_at = ?
        WHERE state IN ('pending','failed') AND expires_at <= ?`).run(now, now);
      const due = this.db.query(`SELECT id FROM media_download WHERE state IN ('pending','failed')
        AND next_attempt_at <= ? AND expires_at > ? ORDER BY expires_at, created_at LIMIT ?`)
        .all(now, now, limit) as Array<{ id: string }>;
      for (const row of due) this.db.query(`UPDATE media_download SET state = 'downloading', attempts = attempts + 1,
        updated_at = ? WHERE id = ? AND state IN ('pending','failed')`).run(now, row.id);
      return due.map(({ id }) => this.db.query(`SELECT id, task_id AS taskId, slot, remote_url AS remoteUrl,
        destination_path AS destinationPath, expires_at AS expiresAt, attempts FROM media_download WHERE id = ?`)
        .get(id) as PendingMediaDownload);
    });
  }

  completeMediaDownload(id: string, sha256: string, now = Date.now()) {
    if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new TypeError("Downloaded artifact must include a SHA-256 hash.");
    return this.atomic(() => {
      const row = this.db.query(`SELECT task_id, slot, destination_path, state, sha256 FROM media_download WHERE id = ?`)
        .get(id) as { task_id: string; slot: string; destination_path: string; state: string; sha256: string | null } | null;
      if (!row) throw new Error(`Unknown media download: ${id}`);
      if (row.state === "downloaded") {
        if (row.sha256 !== sha256.toLowerCase()) throw new Error("Downloaded artifact hash is immutable.");
        return false;
      }
      if (row.state !== "downloading") throw new Error("Only a claimed media download can complete.");
      this.assertArtifactPathAvailable(row.task_id, row.slot, row.destination_path);
      const output = this.db.query(`SELECT path, sha256 FROM media_output WHERE task_id = ? AND slot = ?`)
        .get(row.task_id, row.slot) as { path: string; sha256: string } | null;
      if (output && (output.path !== row.destination_path || output.sha256 !== sha256.toLowerCase())) {
        throw new Error("Output slot already contains a different artifact.");
      }
      if (!output) this.db.query(`INSERT INTO media_output(task_id, slot, path, sha256, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(row.task_id, row.slot, row.destination_path, sha256.toLowerCase(), now);
      this.db.query(`UPDATE generation_task SET state = 'succeeded', updated_at = ? WHERE id = ?`)
        .run(now, row.task_id);
      this.db.query(`UPDATE media_download SET state = 'downloaded', sha256 = ?, updated_at = ? WHERE id = ?`)
        .run(sha256.toLowerCase(), now, id);
      return true;
    });
  }

  failMediaDownload(id: string, errorCode: string, now = Date.now()) {
    if (!errorCode.trim()) throw new TypeError("Download failure code is required.");
    return this.atomic(() => {
      const row = this.db.query(`SELECT attempts, expires_at, state FROM media_download WHERE id = ?`)
        .get(id) as { attempts: number; expires_at: number; state: string } | null;
      if (!row) throw new Error(`Unknown media download: ${id}`);
      if (row.state !== "downloading") throw new Error("Only a claimed media download can fail.");
      if (row.expires_at <= now) {
        this.db.query(`UPDATE media_download SET state = 'expired', last_error_code = ?, updated_at = ? WHERE id = ?`)
          .run(errorCode, now, id);
        return "expired" as const;
      }
      const delayMs = Math.min(5 * 60_000 * 2 ** Math.min(row.attempts - 1, 4), 60 * 60_000);
      this.db.query(`UPDATE media_download SET state = 'failed', next_attempt_at = ?, last_error_code = ?, updated_at = ? WHERE id = ?`)
        .run(now + delayMs, errorCode, now, id);
      return "retry" as const;
    });
  }

  recoverInterruptedMediaDownloads(now = Date.now()) {
    return this.atomic(() => {
      const expired = this.db.query(`UPDATE media_download SET state = 'expired', updated_at = ?
        WHERE state = 'downloading' AND expires_at <= ?`).run(now, now).changes;
      const recovered = this.db.query(`UPDATE media_download SET state = 'failed', next_attempt_at = ?,
        last_error_code = 'interrupted', updated_at = ? WHERE state = 'downloading' AND expires_at > ?`)
        .run(now, now, now).changes;
      return { recovered, expired };
    });
  }

  addFaceReference(input: FaceReferenceInput, now = Date.now()) {
    if (!input.characterId.trim() || !input.assetPath.trim()) throw new TypeError("Character ID and asset path are required.");
    if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new TypeError("Face reference must include the original file SHA-256.");
    if (input.sourceKind === "provider_generated" && (!input.provider?.trim() || !input.modelId?.trim() || !input.generatedAt)) {
      throw new TypeError("Provider-generated references require provider, model, and generation time metadata.");
    }
    if (input.trustExpiresAt !== undefined && (!Number.isSafeInteger(input.trustExpiresAt) || input.trustExpiresAt <= now)) {
      throw new RangeError("Trust expiry must be a future timestamp.");
    }
    const id = randomUUID();
    this.db.query(`INSERT INTO face_reference(id, character_id, asset_path, sha256, source_kind, provider,
      model_id, generated_at, trust_expires_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
      .run(id, input.characterId, input.assetPath, input.sha256.toLowerCase(), input.sourceKind,
        input.provider?.trim() ?? null, input.modelId?.trim() ?? null, input.generatedAt ?? null,
        input.trustExpiresAt ?? null, now);
    return id;
  }

  listFaceReferenceStatuses(now = Date.now(), warningWindowMs = 7 * 24 * 60 * 60_000) {
    if (!Number.isSafeInteger(warningWindowMs) || warningWindowMs < 0) throw new RangeError("Warning window must be a non-negative integer.");
    const rows = this.db.query(`SELECT id, character_id AS characterId, asset_path AS assetPath,
      sha256, source_kind AS sourceKind, provider, model_id AS modelId, generated_at AS generatedAt,
      trust_expires_at AS trustExpiresAt, status, supersedes_id AS supersedesId
      FROM face_reference WHERE status = 'active' ORDER BY character_id, created_at`).all() as Array<{
        id: string; characterId: string; assetPath: string; sha256: string;
        sourceKind: FaceReferenceInput["sourceKind"]; provider: string | null; modelId: string | null;
        generatedAt: number | null; trustExpiresAt: number | null; status: "active"; supersedesId: string | null;
      }>;
    return rows.map((row) => ({ ...row,
      trust: row.trustExpiresAt === null ? "unbounded" as const
        : row.trustExpiresAt <= now ? "expired" as const
        : row.trustExpiresAt <= now + warningWindowMs ? "warning" as const : "valid" as const,
    }));
  }

  renewFaceReference(previousId: string, input: FaceReferenceInput, now = Date.now()) {
    return this.atomic(() => {
      const previous = this.db.query(`SELECT character_id, status FROM face_reference WHERE id = ?`)
        .get(previousId) as { character_id: string; status: string } | null;
      if (!previous) throw new Error(`Unknown face reference: ${previousId}`);
      if (previous.status !== "active") throw new Error("Only the active face reference can be renewed.");
      if (previous.character_id !== input.characterId) throw new Error("Renewal must keep the same character identity.");
      const replacementId = this.addFaceReference(input, now);
      this.db.query(`UPDATE face_reference SET status = 'superseded' WHERE id = ?`).run(previousId);
      this.db.query(`UPDATE face_reference SET supersedes_id = ? WHERE id = ?`).run(previousId, replacementId);
      return replacementId;
    });
  }

  /** Persist dispatch intent before network I/O. A crash after this point must reconcile, never blindly resubmit. */
  beginSubmission(id: string): DispatchResult {
    return this.atomic(() => this.beginSubmissionInTransaction(id));
  }

  private beginSubmissionInTransaction(id: string): DispatchResult {
    const task = this.getTask(id);
    if (task.state === "succeeded") return { status: "already_succeeded" as const, task };
    if (task.state !== "queued" || task.requestStarted) return { status: "already_dispatched" as const, task };

    if (task.stage === "text" && task.billable) {
      const authorization = this.getTextAuthorization(id);
      const price = this.getTaskPriceSnapshot(id);
      if (!authorization || !price || authorization.maxCalls !== 1 || authorization.priceRuleId !== price.priceRuleId
        || authorization.currency !== task.currency || task.estimatedCostMicros > authorization.maxCostMicros
        || authorization.approvedRequestHash !== createHash("sha256").update(task.requestJson).digest("hex")) {
        throw new Error("付费编剧任务缺少有效的按次授权和价格快照");
      }
    }

    let episodeWarning = false;
    if (task.billable) {
      const episodeUsage = this.usageFor({ type: "episode", key: episodeBudgetKey(task.projectId, task.episodeId) }, task.currency);
      if (episodeUsage.configured && (episodeUsage.usedMicros >= episodeUsage.limitMicros
        || task.estimatedCostMicros > episodeUsage.limitMicros - episodeUsage.usedMicros)) {
        return { status: "budget_exhausted" as const, task,
          usedMicros: episodeUsage.usedMicros, limitMicros: episodeUsage.limitMicros };
      }
      episodeWarning = episodeUsage.configured &&
        BigInt(episodeUsage.usedMicros + task.estimatedCostMicros) * 10000n >=
        BigInt(episodeUsage.limitMicros) * BigInt(episodeUsage.warningBasisPoints);
    }

    const reservation = task.billable ? this.globalBudgets.reserve(task) : null;
    if (reservation && !reservation.allowed) {
      return { status: "budget_exhausted" as const, task,
        usedMicros: reservation.exceeded.usedMicros, limitMicros: reservation.exceeded.limitMicros };
    }
    const now = Date.now();
    if (task.billable) {
      this.db.query(`INSERT INTO task_reservation(task_id, amount_micros, currency, state, updated_at)
        VALUES (?, ?, ?, 'active', ?)`).run(id, task.estimatedCostMicros, task.currency, now);
    }
    this.db.query(`UPDATE generation_task SET state = 'dispatching', request_started = 1,
      attempt = attempt + 1, updated_at = ? WHERE id = ? AND state = 'queued' AND request_started = 0`)
      .run(now, id);
    const updated = this.getTask(id);
    const reservedMicros = task.billable ? task.estimatedCostMicros : 0;
    const usedAfterReserveMicros = reservation?.allowed
      ? reservation.usedAfterReserveMicros : this.getBudgetUsage().usedMicros;
    return reservation?.warning || episodeWarning
      ? { status: "warning_90" as const, task: updated, reservedMicros, usedAfterReserveMicros }
      : { status: "started" as const, task: updated, reservedMicros, usedAfterReserveMicros };
  }

  registerProviderTask(id: string, providerTaskId: string) {
    if (!providerTaskId.trim()) throw new TypeError("Provider task ID is required.");
    this.atomic(() => {
      const task = this.row(id);
      if (task.state === "succeeded") throw new Error("A successful task cannot be resubmitted or rebound.");
      if (task.provider_task_id && task.provider_task_id !== providerTaskId) throw new Error("Provider task ID is immutable once recorded.");
      if (!task.request_started) throw new Error("Provider task cannot be attached before dispatch intent is persisted.");
      this.db.query(`UPDATE generation_task SET provider_task_id = ?, state = 'running', updated_at = ? WHERE id = ?`)
        .run(providerTaskId, Date.now(), id);
    });
    return this.getTask(id);
  }

  markReconciliationRequired(id: string) {
    this.atomic(() => {
      const task = this.row(id);
      if (!task.request_started) throw new Error("Reconciliation is only valid after dispatch intent is persisted.");
      if (task.state === "succeeded") throw new Error("A successful task cannot require reconciliation.");
      if (task.provider_task_id) {
        this.db.query(`UPDATE generation_task SET state = 'reconciling', updated_at = ? WHERE id = ?`)
          .run(Date.now(), id);
      } else {
        this.db.query(`UPDATE generation_task SET state = 'reconcile_required', updated_at = ? WHERE id = ?`)
          .run(Date.now(), id);
      }
    });
    return this.getTask(id);
  }

  private insertCharge(id: string, sourceRef: string, amountMicros: number, currency: string, details: ChargeDetails) {
    const { unit, units, unitPriceMicros, pricingRef, status = "reconciled" } = details;
    const suppliedPricing = unit !== undefined || units !== undefined || unitPriceMicros !== undefined;
    if (suppliedPricing && (!unit?.trim() || units === undefined || unitPriceMicros === undefined)) {
      throw new TypeError("Unit, units, and unit price must be supplied together.");
    }
    if (units !== undefined && (!Number.isSafeInteger(units) || units < 0)) throw new RangeError("Units must be a non-negative safe integer.");
    if (unitPriceMicros !== undefined) assertMoney(unitPriceMicros, currency);
    if (units !== undefined && unitPriceMicros !== undefined && BigInt(units) * BigInt(unitPriceMicros) !== BigInt(amountMicros)) {
      throw new Error("Charge amount must equal units multiplied by unit price.");
    }
    this.db.query(`INSERT INTO cost_ledger(task_id, source_ref, amount_micros, currency, unit, units,
      unit_price_micros, pricing_ref, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, sourceRef, amountMicros, currency, unit?.trim() ?? null, units ?? null,
        unitPriceMicros ?? null, pricingRef?.trim() ?? null, status, Date.now());
  }

  private chargeDetailsForTask(id: string, details: ChargeDetails): ChargeDetails {
    const snapshot = this.getTaskPriceSnapshot(id);
    if (!snapshot) return details;
    if (details.pricingRef && details.pricingRef !== snapshot.priceRuleId) {
      throw new Error("Charge price rule differs from the task's confirmed quote.");
    }
    return { ...details, pricingRef: snapshot.priceRuleId,
      status: details.status ?? (details.units === undefined ? "manual" : "reconciled") };
  }

  recordCharge(id: string, sourceRef: string, amountMicros: number, currency: string, details: ChargeDetails = {}) {
    currency = currency.toUpperCase();
    assertMoney(amountMicros, currency);
    if (!sourceRef.trim()) throw new TypeError("Charge source reference is required.");
    return this.atomic(() => {
      const task = this.row(id);
      if (currency !== task.currency) throw new Error(`Charge currency mismatch: ${currency} != ${task.currency}`);
      const pricedDetails = this.chargeDetailsForTask(id, details);
      this.globalBudgets.recordCharge(toTask(task), sourceRef, amountMicros, currency, pricedDetails);
      const existing = this.db.query("SELECT amount_micros, currency FROM cost_ledger WHERE source_ref = ?")
        .get(sourceRef) as { amount_micros: number; currency: string } | null;
      if (existing) {
        if (existing.amount_micros !== amountMicros || existing.currency !== currency) throw new Error("Charge reference reused with different amount.");
        return false;
      }
      this.insertCharge(id, sourceRef, amountMicros, currency, pricedDetails);
      return true;
    });
  }

  /** Post the reconciled provider cost exactly once, then replace the estimate reservation with actual spend. */
  settleReservation(id: string, sourceRef: string, actualCostMicros: number, currency: string, details: ChargeDetails = {}) {
    currency = currency.toUpperCase();
    assertMoney(actualCostMicros, currency);
    if (!sourceRef.trim()) throw new TypeError("Settlement reference is required.");
    return this.atomic(() => {
      const task = this.row(id);
      if (!task.billable) throw new Error("A non-billable task cannot settle provider cost.");
      if (currency !== task.currency) throw new Error(`Settlement currency mismatch: ${currency} != ${task.currency}`);
      const pricedDetails = this.chargeDetailsForTask(id, details);
      this.globalBudgets.settle(toTask(task), sourceRef, actualCostMicros, currency, pricedDetails);
      const existing = this.db.query("SELECT task_id, amount_micros, currency FROM cost_ledger WHERE source_ref = ?")
        .get(sourceRef) as { task_id: string; amount_micros: number; currency: string } | null;
      let inserted = false;
      if (existing) {
        if (existing.task_id !== id || existing.amount_micros !== actualCostMicros || existing.currency !== currency) {
          throw new Error("Settlement reference reused with different task or amount.");
        }
      } else {
        this.insertCharge(id, sourceRef, actualCostMicros, currency, pricedDetails);
        inserted = true;
      }
      this.db.query(`UPDATE task_reservation SET state = 'settled', updated_at = ?
        WHERE task_id = ? AND state = 'active'`).run(Date.now(), id);
      return inserted;
    });
  }

  releaseReservation(id: string, confirmedNoCharge: true) {
    if (confirmedNoCharge !== true) throw new Error("Reservation release requires explicit no-charge confirmation.");
    this.atomic(() => {
      const task = this.row(id);
      if (task.billable) {
        const charge = this.db.query("SELECT 1 AS found FROM cost_ledger WHERE task_id = ? LIMIT 1").get(id);
        if (charge) throw new Error("Cannot release a reservation after any provider cost was recorded.");
        this.globalBudgets.release(id, true);
      }
      this.db.query(`UPDATE task_reservation SET state = 'released', updated_at = ?
        WHERE task_id = ? AND state = 'active'`).run(Date.now(), id);
    });
  }

  getTextOutput(id: string) {
    return this.db.query(`SELECT response_text AS responseText, response_sha256 AS sha256,
      provider_request_id AS providerRequestId, usage_json AS usageJson FROM text_output WHERE task_id = ?`)
      .get(id) as { responseText: string; sha256: string; providerRequestId: string; usageJson: string } | null;
  }

  findTaskByIdempotencyKey(key: string) {
    const row = this.db.query(`SELECT ${taskColumns} FROM generation_task WHERE idempotency_key = ?`).get(key) as TaskRow | null;
    return row ? toTask(row) : null;
  }

  getTextAuthorization(taskId: string): TextTaskAuthorization | null {
    const row = this.db.query("SELECT authorization_json AS value FROM text_task_authorization WHERE task_id = ?").get(taskId) as { value: string } | null;
    return row ? JSON.parse(row.value) : null;
  }

  completeTextTask(id: string, output: { responseText: string; providerRequestId: string; usageJson: string }) {
    if (!output.responseText.trim() || output.responseText.length > 2_000_000 || !output.providerRequestId.trim()) {
      throw new Error("Text output and provider request ID are required; response limit is 2 MB characters.");
    }
    JSON.parse(output.usageJson);
    const sha256 = createHash("sha256").update(output.responseText).digest("hex");
    return this.atomic(() => {
      const task = this.getTask(id);
      if (task.stage !== "text" || !task.requestStarted) throw new Error("Text task must have a persisted dispatch intent.");
      const old = this.getTextOutput(id);
      if (old) {
        if (old.sha256 !== sha256 || old.providerRequestId !== output.providerRequestId || old.usageJson !== output.usageJson) {
          throw new Error("Successful text output is immutable.");
        }
        return old;
      }
      if (task.state === "succeeded") throw new Error("Successful task has no text receipt; reconciliation required.");
      this.db.query(`INSERT INTO text_output(task_id, response_text, response_sha256, provider_request_id, usage_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, output.responseText, sha256, output.providerRequestId, output.usageJson, Date.now());
      this.db.query("UPDATE generation_task SET state = 'succeeded', updated_at = ? WHERE id = ?").run(Date.now(), id);
      return { ...output, sha256 };
    });
  }

  completeTask(id: string, output: { slot: string; path: string; sha256: string }) {
    if (this.getTask(id).stage === "text") throw new Error("Text tasks must persist a text response receipt.");
    if (!output.slot.trim() || !output.path.trim() || !/^[a-f0-9]{64}$/i.test(output.sha256)) {
      throw new TypeError("Output slot, path, and SHA-256 are required.");
    }
    return this.atomic(() => {
      const task = this.row(id);
      this.assertArtifactPathAvailable(id, output.slot, output.path);
      const existing = this.db.query(`SELECT slot, path, sha256 FROM media_output WHERE task_id = ? AND slot = ?`)
        .get(id, output.slot) as { slot: string; path: string; sha256: string } | null;
      if (task.state === "succeeded") {
        if (!existing || existing.path !== output.path || existing.sha256 !== output.sha256) {
          throw new Error("Successful output is immutable; create an explicit redo task instead.");
        }
        return { created: false, output: existing };
      }
      if (!task.request_started) throw new Error("Task cannot succeed before dispatch intent is persisted.");
      if (existing && (existing.path !== output.path || existing.sha256 !== output.sha256)) {
        throw new Error("Output slot already contains a different artifact.");
      }
      const pathOwner = this.db.query(`SELECT task_id FROM media_output WHERE path = ? AND task_id != ? LIMIT 1`)
        .get(output.path, id) as { task_id: string } | null;
      if (pathOwner) throw new Error("Output paths are immutable and cannot replace another task's artifact.");
      if (!existing) {
        this.db.query(`INSERT INTO media_output(task_id, slot, path, sha256, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(id, output.slot, output.path, output.sha256.toLowerCase(), Date.now());
      }
      this.db.query(`UPDATE generation_task SET state = 'succeeded', updated_at = ? WHERE id = ?`).run(Date.now(), id);
      return { created: !existing, output: existing ?? { ...output, sha256: output.sha256.toLowerCase() } };
    });
  }

  failTask(id: string, confirmedNoCharge = false) {
    this.atomic(() => {
      const task = this.row(id);
      if (task.state === "succeeded") throw new Error("A successful task cannot be marked failed.");
      if (confirmedNoCharge && task.billable) {
        const charge = this.db.query("SELECT 1 AS found FROM cost_ledger WHERE task_id = ? LIMIT 1").get(id);
        if (charge) throw new Error("Cannot release a reservation after any provider cost was recorded.");
        this.globalBudgets.release(id, true);
      }
      this.db.query(`UPDATE generation_task SET state = 'failed', updated_at = ? WHERE id = ?`).run(Date.now(), id);
      if (confirmedNoCharge) this.db.query(`UPDATE task_reservation SET state = 'released', updated_at = ? WHERE task_id = ? AND state = 'active'`)
        .run(Date.now(), id);
    });
    return this.getTask(id);
  }

  pauseTask(id: string) {
    this.atomic(() => {
      const task = this.row(id);
      if (task.state === "succeeded" || task.state === "failed") throw new Error("Terminal tasks cannot be paused.");
      if (task.state === "paused") return;
      this.db.query(`UPDATE generation_task SET state = 'paused', updated_at = ? WHERE id = ?`).run(Date.now(), id);
    });
    return this.getTask(id);
  }

  /** Resume queue work only if no dispatch intent exists; submitted work resumes through reconciliation. */
  resumeTask(id: string) {
    this.atomic(() => {
      const task = this.row(id);
      if (task.state !== "paused") throw new Error("Only a paused task can be resumed.");
      const state: TaskState = !task.request_started ? "queued"
        : task.provider_task_id ? "reconciling" : "reconcile_required";
      this.db.query(`UPDATE generation_task SET state = ?, updated_at = ? WHERE id = ?`).run(state, Date.now(), id);
    });
    return this.getTask(id);
  }

  /** Local renders may retry after failure or startup recovery; this never resets a paid generation task. */
  retryLocalSynthesis(id: string) {
    return this.atomic(() => {
      const task = this.row(id);
      if (task.stage !== "synthesis" || task.provider !== "local-synth" || task.billable || task.provider_task_id) {
        throw new Error("Only a non-billable local synthesis can be retried through this path.");
      }
      if (task.state !== "failed" && task.state !== "reconcile_required") {
        throw new Error("Only failed or recovered local synthesis can be retried.");
      }
      if (!this.getSynthesisExport(id)) throw new Error("Synthesis manifest is missing.");
      this.db.query(`UPDATE generation_task SET state = 'queued', request_started = 0, updated_at = ? WHERE id = ?`)
        .run(Date.now(), id);
      return this.getTask(id);
    });
  }

  /** Startup recovery requires the former process to have stopped; do not call against live workers. */
  recoverInterrupted() {
    return this.atomic(() => {
      const rows = this.db.query(`SELECT id, provider_task_id FROM generation_task
        WHERE state IN ('dispatching','running')`).all() as { id: string; provider_task_id: string | null }[];
      let reconciling = 0;
      let requiresReview = 0;
      for (const row of rows) {
        if (row.provider_task_id) {
          this.db.query(`UPDATE generation_task SET state = 'reconciling', updated_at = ? WHERE id = ?`)
            .run(Date.now(), row.id);
          reconciling++;
        } else {
          this.db.query(`UPDATE generation_task SET state = 'reconcile_required', updated_at = ? WHERE id = ?`)
            .run(Date.now(), row.id);
          requiresReview++;
        }
      }
      return { reconciling, requiresReview };
    });
  }
}

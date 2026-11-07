import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { checkEpisodeScript, checkSourceEvidence, indexNovel, type SourceEvidence } from "./novelAdaptation";

export type SourceKind = "synopsis" | "novel" | "script";
export type ReviewState = "draft" | "confirmed" | "changes_requested";
export type RuntimeState = "idle" | "queued" | "running" | "paused" | "failed" | "succeeded";
export type VideoReadiness = "blocked" | "ready";
export type DialogueKind = "dialogue" | "narration" | "voiceover" | "phone";
export type CandidateState = "pending" | "linked" | "ignored";
export type AssetKind = "character" | "prop" | "costume";
export type DraftEvidence = string | SourceEvidence;

export type EpisodeDraft = {
  episodeNumber: number; title: string; logline: string; outline: string[]; script: unknown[];
  scenes: Array<{ name: string; location: string; atmosphere: string; timeWeather: string; evidence: DraftEvidence[] }>;
  characters: Array<{ name: string; aliases: string[]; stableDescription: string; evidence: DraftEvidence[]; firstAppearance: string }>;
  props?: Array<{ name: string; aliases: string[]; stableDescription: string; evidence: DraftEvidence[]; firstAppearance: string }>;
  shots: Array<{ sequence: number; sceneName: string; title: string; scriptExcerpt: string; evidence: DraftEvidence[];
    durationMs: number; shotSize: string; movement: string; promptText: string; characterNames: string[];
    propUses?: Array<{ name: string; holderBeforeName?: string; holderAfterName?: string;
      stateBefore: string; stateAfter: string; interaction: string; evidence: DraftEvidence[] }>;
    dialogue: Array<{ kind: DialogueKind; speakerName?: string; listenerName?: string; text: string; emotion?: string; voiceProfile?: string }> }>;
};

export class ProductionCatalog {
  constructor(readonly db: Database) {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS production_project (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('synopsis','novel','script')),
        source_text TEXT NOT NULL,
        workflow_state TEXT NOT NULL DEFAULT 'draft' CHECK (workflow_state IN ('draft','analyzing','producing','paused','completed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS story_analysis (
        project_id TEXT PRIMARY KEY REFERENCES production_project(id),
        events_json TEXT NOT NULL,
        relations_json TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS production_episode (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES production_project(id),
        episode_number INTEGER NOT NULL CHECK (episode_number >= 1),
        title TEXT NOT NULL,
        logline TEXT NOT NULL DEFAULT '',
        outline_json TEXT NOT NULL DEFAULT '[]',
        script_json TEXT NOT NULL DEFAULT '[]',
        review_state TEXT NOT NULL DEFAULT 'draft' CHECK (review_state IN ('draft','confirmed','changes_requested')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (project_id, episode_number)
      );
      CREATE TABLE IF NOT EXISTS production_scene (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES production_project(id),
        name TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        atmosphere TEXT NOT NULL DEFAULT '',
        time_weather TEXT NOT NULL DEFAULT '',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (project_id, canonical_name)
      );
      CREATE TABLE IF NOT EXISTS production_asset (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES production_project(id),
        kind TEXT NOT NULL CHECK (kind IN ('character','prop','costume')),
        name TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        stable_description TEXT NOT NULL DEFAULT '',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        first_appearance TEXT NOT NULL DEFAULT '',
        variant_of TEXT REFERENCES production_asset(id),
        locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (project_id, kind, canonical_name)
      );
      CREATE TABLE IF NOT EXISTS production_shot (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES production_project(id),
        episode_id TEXT NOT NULL REFERENCES production_episode(id),
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        scene_id TEXT REFERENCES production_scene(id),
        title TEXT NOT NULL DEFAULT '',
        script_excerpt TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        shot_size TEXT NOT NULL DEFAULT '',
        camera_angle TEXT NOT NULL DEFAULT '',
        movement TEXT NOT NULL DEFAULT '',
        action_beats_json TEXT NOT NULL DEFAULT '[]',
        duration_ms INTEGER NOT NULL DEFAULT 5000 CHECK (duration_ms > 0),
        prompt_text TEXT NOT NULL DEFAULT '',
        prompt_version INTEGER NOT NULL DEFAULT 0 CHECK (prompt_version >= 0),
        review_state TEXT NOT NULL DEFAULT 'draft' CHECK (review_state IN ('draft','confirmed','changes_requested')),
        runtime_state TEXT NOT NULL DEFAULT 'idle' CHECK (runtime_state IN ('idle','queued','running','paused','failed','succeeded')),
        video_readiness TEXT NOT NULL DEFAULT 'blocked' CHECK (video_readiness IN ('blocked','ready')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (episode_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS shot_character_link (
        shot_id TEXT NOT NULL REFERENCES production_shot(id),
        character_id TEXT NOT NULL REFERENCES production_asset(id),
        costume_id TEXT REFERENCES production_asset(id),
        PRIMARY KEY (shot_id, character_id)
      );
      CREATE TABLE IF NOT EXISTS shot_prop_link (
        shot_id TEXT NOT NULL REFERENCES production_shot(id),
        prop_id TEXT NOT NULL REFERENCES production_asset(id),
        holder_before_id TEXT REFERENCES production_asset(id),
        holder_after_id TEXT REFERENCES production_asset(id),
        state_before TEXT NOT NULL,
        state_after TEXT NOT NULL,
        interaction TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        PRIMARY KEY (shot_id, prop_id)
      );
      CREATE TABLE IF NOT EXISTS shot_dialogue (
        id TEXT PRIMARY KEY,
        shot_id TEXT NOT NULL REFERENCES production_shot(id),
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        kind TEXT NOT NULL CHECK (kind IN ('dialogue','narration','voiceover','phone')),
        speaker_id TEXT REFERENCES production_asset(id),
        listener_id TEXT REFERENCES production_asset(id),
        text TEXT NOT NULL,
        emotion TEXT NOT NULL DEFAULT '',
        voice_profile TEXT NOT NULL DEFAULT '',
        UNIQUE (shot_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS extracted_candidate (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES production_project(id),
        episode_id TEXT NOT NULL REFERENCES production_episode(id),
        shot_id TEXT NOT NULL REFERENCES production_shot(id),
        kind TEXT NOT NULL CHECK (kind IN ('character','scene','prop','costume','dialogue')),
        candidate_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','linked','ignored')),
        linked_entity_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS production_shot_episode_order ON production_shot(episode_id, sequence);
      CREATE TABLE IF NOT EXISTS adaptation_input (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES production_project(id),
        episode_number INTEGER NOT NULL,
        source_hash TEXT NOT NULL,
        template_version TEXT NOT NULL,
        request_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(project_id, id)
      );
      CREATE INDEX IF NOT EXISTS shot_prop_link_prop ON shot_prop_link(prop_id);
      CREATE TABLE IF NOT EXISTS adaptation_adoption (
        task_id TEXT PRIMARY KEY,
        input_id TEXT NOT NULL REFERENCES adaptation_input(id),
        response_hash TEXT NOT NULL,
        episode_id TEXT NOT NULL UNIQUE REFERENCES production_episode(id),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS extracted_candidate_state ON extracted_candidate(project_id, state, kind);
      CREATE TABLE IF NOT EXISTS episode_review (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL REFERENCES production_episode(id),
        snapshot_hash TEXT NOT NULL,
        result_hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('confirmed','changes_requested')),
        note TEXT NOT NULL,
        reviewed_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS episode_review_history ON episode_review(episode_id, created_at);
      CREATE TABLE IF NOT EXISTS asset_reference (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES production_project(id),
        entity_kind TEXT NOT NULL CHECK (entity_kind IN ('asset','scene')),
        entity_id TEXT NOT NULL,
        entity_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('headshot','fullBody','scene','prop','costume')),
        version INTEGER NOT NULL CHECK (version > 0),
        previous_id TEXT REFERENCES asset_reference(id),
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        source_note TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('user_authorized')),
        created_at INTEGER NOT NULL,
        UNIQUE(project_id, entity_kind, entity_id, role, version)
      );
    `);
    db.query(`INSERT INTO schema_migration(version, applied_at) VALUES (3, ?) ON CONFLICT(version) DO NOTHING`)
      .run(Date.now());
    db.query(`INSERT INTO schema_migration(version, applied_at) VALUES (4, ?) ON CONFLICT(version) DO NOTHING`)
      .run(Date.now());
    db.query(`INSERT INTO schema_migration(version, applied_at) VALUES (5, ?) ON CONFLICT(version) DO NOTHING`)
      .run(Date.now());
    db.query(`INSERT INTO schema_migration(version, applied_at) VALUES (6, ?) ON CONFLICT(version) DO NOTHING`)
      .run(Date.now());
    db.query(`INSERT INTO schema_migration(version, applied_at) VALUES (7, ?) ON CONFLICT(version) DO NOTHING`)
      .run(Date.now());
  }

  private atomic<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  withTransaction<T>(operation: () => T): T { return this.atomic(operation); }

  importStory(input: { title: string; sourceKind: SourceKind; sourceText: string }) {
    if (!input.title.trim() || !input.sourceText.trim()) throw new TypeError("Story title and source text are required.");
    const id = randomUUID();
    const now = Date.now();
    this.db.query(`INSERT INTO production_project(id, title, source_kind, source_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, input.title.trim(), input.sourceKind, input.sourceText, now, now);
    return id;
  }

  listStories() {
    return this.db.query(`SELECT id, title, source_kind AS sourceKind, workflow_state AS workflowState,
      created_at AS createdAt, updated_at AS updatedAt FROM production_project ORDER BY created_at DESC, id DESC`)
      .all() as Array<{ id: string; title: string; sourceKind: SourceKind; workflowState: string; createdAt: number; updatedAt: number }>;
  }

  getStory(projectId: string) {
    return this.db.query(`SELECT id, title, source_kind AS sourceKind, source_text AS sourceText,
      workflow_state AS workflowState, created_at AS createdAt, updated_at AS updatedAt
      FROM production_project WHERE id = ?`).get(projectId) as
      | { id: string; title: string; sourceKind: SourceKind; sourceText: string; workflowState: string; createdAt: number; updatedAt: number }
      | null;
  }

  saveStoryAnalysis(projectId: string, analysis: { events: unknown[]; relations: unknown[] }, version: number) {
    if (!Number.isSafeInteger(version) || version < 1) throw new RangeError("Analysis version must be positive.");
    if (!Array.isArray(analysis.events) || !Array.isArray(analysis.relations)) throw new TypeError("Events and relations must be arrays.");
    this.db.query(`INSERT INTO story_analysis(project_id, events_json, relations_json, version, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET events_json = excluded.events_json,
      relations_json = excluded.relations_json, version = excluded.version, updated_at = excluded.updated_at`)
      .run(projectId, JSON.stringify(analysis.events), JSON.stringify(analysis.relations), version, Date.now());
  }

  createEpisode(projectId: string, episodeNumber: number, title: string, logline = "") {
    if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1 || !title.trim()) throw new TypeError("Episode number and title are required.");
    const id = randomUUID();
    const now = Date.now();
    this.db.query(`INSERT INTO production_episode(id, project_id, episode_number, title, logline, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, projectId, episodeNumber, title.trim(), logline, now, now);
    return id;
  }

  listEpisodes(projectId: string) {
    return this.db.query(`SELECT e.id, e.project_id AS projectId, e.episode_number AS episodeNumber,
      e.title, e.logline, e.review_state AS reviewState, e.created_at AS createdAt,
      e.updated_at AS updatedAt, COUNT(s.id) AS shotCount
      FROM production_episode e LEFT JOIN production_shot s ON s.episode_id = e.id
      WHERE e.project_id = ? GROUP BY e.id ORDER BY e.episode_number`)
      .all(projectId) as Array<{ id: string; projectId: string; episodeNumber: number; title: string;
        logline: string; reviewState: ReviewState; createdAt: number; updatedAt: number; shotCount: number }>;
  }

  getEpisode(episodeId: string) {
    return this.db.query(`SELECT id, project_id AS projectId, episode_number AS episodeNumber,
      title, logline, review_state AS reviewState, created_at AS createdAt, updated_at AS updatedAt
      FROM production_episode WHERE id = ?`).get(episodeId) as
      | { id: string; projectId: string; episodeNumber: number; title: string; logline: string;
        reviewState: ReviewState; createdAt: number; updatedAt: number } | null;
  }

  getProjectProduction(projectId: string) {
    if (!projectId.trim()) throw new TypeError("Project ID is required.");
    const story = this.getStory(projectId);
    const chapterIndex = story?.sourceKind === "novel" ? indexNovel(story.sourceText) : null;
    const analysisRow = this.db.query(`SELECT events_json AS eventsJson, relations_json AS relationsJson,
      version, updated_at AS updatedAt FROM story_analysis WHERE project_id = ?`).get(projectId) as
      | { eventsJson: string; relationsJson: string; version: number; updatedAt: number } | null;
    const episodes = this.db.query(`SELECT id, episode_number AS episodeNumber, title, logline,
      outline_json AS outlineJson, script_json AS scriptJson, review_state AS reviewState,
      created_at AS createdAt, updated_at AS updatedAt FROM production_episode
      WHERE project_id = ? ORDER BY episode_number`).all(projectId) as Array<{
        id: string; episodeNumber: number; title: string; logline: string; outlineJson: string;
        scriptJson: string; reviewState: ReviewState; createdAt: number; updatedAt: number }>;
    const assets = this.db.query(`SELECT id, kind, name, aliases_json AS aliasesJson,
      stable_description AS stableDescription, evidence_json AS evidenceJson,
      first_appearance AS firstAppearance, variant_of AS variantOf, locked,
      created_at AS createdAt, updated_at AS updatedAt FROM production_asset
      WHERE project_id = ? ORDER BY kind, name`).all(projectId) as Array<{
        id: string; kind: AssetKind; name: string; aliasesJson: string; stableDescription: string;
        evidenceJson: string; firstAppearance: string; variantOf: string | null;
        locked: number; createdAt: number; updatedAt: number }>;
    const scenes = this.db.query(`SELECT id, name, location, atmosphere, time_weather AS timeWeather,
      evidence_json AS evidenceJson, locked, created_at AS createdAt, updated_at AS updatedAt
      FROM production_scene WHERE project_id = ? ORDER BY name`).all(projectId) as Array<{
        id: string; name: string; location: string; atmosphere: string; timeWeather: string;
        evidenceJson: string; locked: number; createdAt: number; updatedAt: number }>;
    const shots = this.db.query(`SELECT s.id, s.episode_id AS episodeId, e.episode_number AS episodeNumber,
      s.sequence, s.scene_id AS sceneId, s.title, s.script_excerpt AS scriptExcerpt,
      s.evidence_json AS evidenceJson, s.shot_size AS shotSize, s.camera_angle AS cameraAngle,
      s.movement, s.duration_ms AS durationMs, s.prompt_text AS promptText,
      s.prompt_version AS promptVersion, s.review_state AS reviewState,
      s.runtime_state AS runtimeState, s.video_readiness AS videoReadiness
      FROM production_shot s JOIN production_episode e ON e.id = s.episode_id
      WHERE s.project_id = ? ORDER BY e.episode_number, s.sequence`).all(projectId) as Array<{
        id: string; episodeId: string; episodeNumber: number; sequence: number; sceneId: string | null;
        title: string; scriptExcerpt: string; evidenceJson: string; shotSize: string;
        cameraAngle: string; movement: string; durationMs: number; promptText: string;
        promptVersion: number; reviewState: ReviewState; runtimeState: RuntimeState;
        videoReadiness: VideoReadiness }>;
    const shotProps = this.db.query(`SELECT l.shot_id AS shotId, l.prop_id AS propId, p.name AS propName,
      l.holder_before_id AS holderBeforeId, before_holder.name AS holderBeforeName,
      l.holder_after_id AS holderAfterId, after_holder.name AS holderAfterName,
      l.state_before AS stateBefore, l.state_after AS stateAfter,
      l.interaction, l.evidence_json AS evidenceJson
      FROM shot_prop_link l JOIN production_shot s ON s.id = l.shot_id
      JOIN production_asset p ON p.id = l.prop_id
      LEFT JOIN production_asset before_holder ON before_holder.id = l.holder_before_id
      LEFT JOIN production_asset after_holder ON after_holder.id = l.holder_after_id
      WHERE s.project_id = ? ORDER BY s.episode_id, s.sequence, p.name`).all(projectId) as Array<{
        shotId: string; propId: string; propName: string; holderBeforeId: string | null;
        holderBeforeName: string | null; holderAfterId: string | null; holderAfterName: string | null;
        stateBefore: string; stateAfter: string; interaction: string; evidenceJson: string }>;
    return {
      chapterIndex,
      adaptationAdoptions: this.db.query(`SELECT a.task_id AS taskId, a.episode_id AS episodeId FROM adaptation_adoption a
        JOIN production_episode e ON e.id = a.episode_id WHERE e.project_id = ?`).all(projectId) as Array<{ taskId: string; episodeId: string }>,
      adaptationInputs: this.db.query(`SELECT id, episode_number AS episodeNumber, source_hash AS sourceHash,
        template_version AS templateVersion, created_at AS createdAt FROM adaptation_input
        WHERE project_id = ? ORDER BY created_at DESC, id`).all(projectId) as Array<{
          id: string; episodeNumber: number; sourceHash: string; templateVersion: string; createdAt: number }>,
      analysis: analysisRow ? { events: JSON.parse(analysisRow.eventsJson) as unknown[],
        relations: JSON.parse(analysisRow.relationsJson) as unknown[],
        version: analysisRow.version, updatedAt: analysisRow.updatedAt } : null,
      episodes: episodes.map(({ outlineJson, scriptJson, ...episode }) => {
        const script = JSON.parse(scriptJson) as unknown[];
        return { ...episode, outline: JSON.parse(outlineJson) as string[], script,
          scriptReport: checkEpisodeScript(script, chapterIndex?.chapters ?? [], undefined, !!chapterIndex) };
      }),
      assets: assets.map(({ aliasesJson, evidenceJson, locked, ...asset }) => ({ ...asset,
        aliases: JSON.parse(aliasesJson) as string[], evidence: JSON.parse(evidenceJson) as unknown[], locked: !!locked })),
      scenes: scenes.map(({ evidenceJson, locked, ...scene }) => ({ ...scene,
        evidence: JSON.parse(evidenceJson) as unknown[], locked: !!locked })),
      shots: shots.map(({ evidenceJson, ...shot }) => ({ ...shot, evidence: JSON.parse(evidenceJson) as unknown[] })),
      shotProps: shotProps.map(({ evidenceJson, ...link }) => ({ ...link, evidence: JSON.parse(evidenceJson) as unknown[] })),
    };
  }

  saveEpisodeScript(episodeId: string, script: unknown[], reviewState: ReviewState = "draft") {
    if (!Array.isArray(script) || script.length === 0) throw new TypeError("Episode script must contain structured scenes.");
    this.db.query(`UPDATE production_episode SET script_json = ?, review_state = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(script), reviewState, Date.now(), episodeId);
  }

  saveEpisodeOutline(episodeId: string, outline: string[]) {
    if (!outline.length || outline.some((beat) => !beat.trim())) throw new TypeError("Episode outline needs non-empty beats.");
    const updated = this.db.query(`UPDATE production_episode SET outline_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(outline), Date.now(), episodeId);
    if (!updated.changes) throw new Error(`Unknown episode: ${episodeId}`);
  }

  upsertScene(input: { id?: string; projectId: string; name: string; location?: string; atmosphere?: string;
    timeWeather?: string; evidence: unknown[] }) {
    if (!input.projectId.trim() || !input.name.trim() || !Array.isArray(input.evidence)) throw new TypeError("Scene name and evidence are required.");
    const canonicalName = input.name.trim().toLocaleLowerCase();
    const existing = input.id ? this.db.query(`SELECT id, locked, location, atmosphere,
      time_weather AS timeWeather, evidence_json AS evidenceJson FROM production_scene
      WHERE id = ? AND project_id = ?`).get(input.id, input.projectId) as
        | { id: string; locked: number; location: string; atmosphere: string; timeWeather: string; evidenceJson: string } | null
      : this.db.query(`SELECT id, locked, location, atmosphere, time_weather AS timeWeather,
        evidence_json AS evidenceJson FROM production_scene WHERE project_id = ? AND canonical_name = ?`)
        .get(input.projectId, canonicalName) as
          | { id: string; locked: number; location: string; atmosphere: string; timeWeather: string; evidenceJson: string } | null;
    if (existing?.locked) throw new Error("Locked scene assets cannot be overwritten.");
    const id = existing?.id ?? input.id ?? randomUUID();
    const now = Date.now();
    this.db.query(`INSERT INTO production_scene(id, project_id, name, canonical_name, location, atmosphere,
      time_weather, evidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, canonical_name = excluded.canonical_name,
      location = excluded.location, atmosphere = excluded.atmosphere, time_weather = excluded.time_weather,
      evidence_json = excluded.evidence_json, updated_at = excluded.updated_at`)
      .run(id, input.projectId, input.name.trim(), canonicalName, input.location ?? existing?.location ?? "",
        input.atmosphere ?? existing?.atmosphere ?? "", input.timeWeather ?? existing?.timeWeather ?? "",
        JSON.stringify([...(existing ? JSON.parse(existing.evidenceJson) as unknown[] : []), ...input.evidence]), now, now);
    return id;
  }

  upsertAsset(input: { id?: string; projectId: string; kind: AssetKind; name: string; aliases?: string[];
    stableDescription?: string; evidence: unknown[]; firstAppearance?: string; variantOf?: string }) {
    if (!input.projectId.trim() || !input.name.trim() || !Array.isArray(input.evidence)) throw new TypeError("Asset name and evidence are required.");
    const canonicalName = input.name.trim().toLocaleLowerCase();
    const existing = input.id ? this.db.query(`SELECT id, locked, aliases_json AS aliasesJson,
      stable_description AS stableDescription, evidence_json AS evidenceJson,
      first_appearance AS firstAppearance, variant_of AS variantOf FROM production_asset
      WHERE id = ? AND project_id = ?`).get(input.id, input.projectId) as
        | { id: string; locked: number; aliasesJson: string; stableDescription: string;
          evidenceJson: string; firstAppearance: string; variantOf: string | null } | null
      : this.db.query(`SELECT id, locked, aliases_json AS aliasesJson, stable_description AS stableDescription,
        evidence_json AS evidenceJson, first_appearance AS firstAppearance, variant_of AS variantOf
        FROM production_asset WHERE project_id = ? AND kind = ? AND canonical_name = ?`)
        .get(input.projectId, input.kind, canonicalName) as
          | { id: string; locked: number; aliasesJson: string; stableDescription: string;
            evidenceJson: string; firstAppearance: string; variantOf: string | null } | null;
    if (existing?.locked) throw new Error("Locked assets cannot be overwritten.");
    const id = existing?.id ?? input.id ?? randomUUID();
    const now = Date.now();
    this.db.query(`INSERT INTO production_asset(id, project_id, kind, name, canonical_name, aliases_json,
      stable_description, evidence_json, first_appearance, variant_of, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, canonical_name = excluded.canonical_name,
      aliases_json = excluded.aliases_json, stable_description = excluded.stable_description,
      evidence_json = excluded.evidence_json, first_appearance = excluded.first_appearance,
      variant_of = excluded.variant_of, updated_at = excluded.updated_at`)
      .run(id, input.projectId, input.kind, input.name.trim(), canonicalName,
        JSON.stringify([...new Set([...(existing ? JSON.parse(existing.aliasesJson) as string[] : []), ...(input.aliases ?? [])])]),
        input.stableDescription ?? existing?.stableDescription ?? "",
        JSON.stringify([...(existing ? JSON.parse(existing.evidenceJson) as unknown[] : []), ...input.evidence]),
        existing?.firstAppearance || input.firstAppearance || "", input.variantOf ?? existing?.variantOf ?? null, now, now);
    return id;
  }

  setAssetLocked(assetId: string, locked: boolean) {
    const updated = this.db.query(`UPDATE production_asset SET locked = ?, updated_at = ? WHERE id = ?`)
      .run(locked ? 1 : 0, Date.now(), assetId);
    if (!updated.changes) throw new Error(`Unknown production asset: ${assetId}`);
  }

  createShot(input: { projectId: string; episodeId: string; sequence: number; sceneId?: string;
    title?: string; scriptExcerpt: string; evidence: unknown[]; durationMs?: number; shotSize?: string; movement?: string }) {
    if (!input.projectId.trim() || !input.episodeId.trim() || !Number.isSafeInteger(input.sequence)
      || input.sequence < 1 || !input.scriptExcerpt.trim() || !Array.isArray(input.evidence)) {
      throw new TypeError("Shot requires an episode, sequence, script excerpt and evidence.");
    }
    const episode = this.db.query(`SELECT project_id FROM production_episode WHERE id = ?`).get(input.episodeId) as { project_id: string } | null;
    if (!episode || episode.project_id !== input.projectId) throw new Error("Shot episode must belong to the selected project.");
    if (input.sceneId) {
      const scene = this.db.query(`SELECT project_id FROM production_scene WHERE id = ?`).get(input.sceneId) as { project_id: string } | null;
      if (!scene || scene.project_id !== input.projectId) throw new Error("Shot scene must belong to the selected project.");
    }
    const id = randomUUID();
    const now = Date.now();
    this.db.query(`INSERT INTO production_shot(id, project_id, episode_id, sequence, scene_id, title,
      script_excerpt, evidence_json, duration_ms, shot_size, movement, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.projectId, input.episodeId, input.sequence, input.sceneId ?? null, input.title ?? "",
        input.scriptExcerpt, JSON.stringify(input.evidence), input.durationMs ?? 5000, input.shotSize ?? "",
        input.movement ?? "", now, now);
    return id;
  }

  addDialogue(input: { shotId: string; sequence: number; kind: DialogueKind; speakerId?: string;
    listenerId?: string; text: string; emotion?: string; voiceProfile?: string }) {
    if (!input.shotId.trim() || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || !input.text.trim()) {
      throw new TypeError("Dialogue requires a shot, sequence and text.");
    }
    if (input.kind === "dialogue" && !input.speakerId) throw new TypeError("Native dialogue needs a speaker.");
    const id = randomUUID();
    this.db.query(`INSERT INTO shot_dialogue(id, shot_id, sequence, kind, speaker_id, listener_id, text, emotion, voice_profile)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.shotId, input.sequence, input.kind, input.speakerId ?? null, input.listenerId ?? null,
        input.text, input.emotion ?? "", input.voiceProfile ?? "");
    return id;
  }

  setShotWorkflowState(shotId: string, input: { reviewState?: ReviewState; runtimeState?: RuntimeState;
    videoReadiness?: VideoReadiness }) {
    const current = this.db.query(`SELECT review_state AS reviewState, runtime_state AS runtimeState,
      video_readiness AS videoReadiness FROM production_shot WHERE id = ?`)
      .get(shotId) as { reviewState: ReviewState; runtimeState: RuntimeState; videoReadiness: VideoReadiness } | null;
    if (!current) throw new Error(`Unknown production shot: ${shotId}`);
    const updated = { ...current, ...input };
    if (updated.videoReadiness === "ready" && updated.reviewState !== "confirmed") {
      throw new Error("A shot is video-ready only after its content review is confirmed.");
    }
    this.db.query(`UPDATE production_shot SET review_state = ?, runtime_state = ?, video_readiness = ?, updated_at = ? WHERE id = ?`)
      .run(updated.reviewState ?? "pending", updated.runtimeState ?? "idle", updated.videoReadiness ?? "not_ready", Date.now(), shotId);
  }

  setShotPrompt(shotId: string, promptText: string) {
    if (!promptText.trim()) throw new TypeError("Shot prompt cannot be empty.");
    const updated = this.db.query(`UPDATE production_shot SET prompt_text = ?, prompt_version = prompt_version + 1,
      updated_at = ? WHERE id = ?`).run(promptText, Date.now(), shotId);
    if (!updated.changes) throw new Error(`Unknown production shot: ${shotId}`);
  }

  linkCharacterToShot(shotId: string, characterId: string, costumeId?: string) {
    const shot = this.db.query(`SELECT project_id FROM production_shot WHERE id = ?`).get(shotId) as { project_id: string } | null;
    const character = this.db.query(`SELECT project_id, kind FROM production_asset WHERE id = ?`).get(characterId) as { project_id: string; kind: string } | null;
    if (!shot || !character || shot.project_id !== character.project_id || character.kind !== "character") {
      throw new Error("Shot character must be a character asset in the same project.");
    }
    if (costumeId) {
      const costume = this.db.query(`SELECT project_id, kind FROM production_asset WHERE id = ?`).get(costumeId) as { project_id: string; kind: string } | null;
      if (!costume || costume.project_id !== shot.project_id || costume.kind !== "costume") {
        throw new Error("Shot costume must be a costume asset in the same project.");
      }
    }
    this.db.query(`INSERT INTO shot_character_link(shot_id, character_id, costume_id) VALUES (?, ?, ?)
      ON CONFLICT(shot_id, character_id) DO UPDATE SET costume_id = excluded.costume_id`)
      .run(shotId, characterId, costumeId ?? null);
  }

  linkPropToShot(input: { shotId: string; propId: string; holderBeforeId?: string;
    holderAfterId?: string; stateBefore: string; stateAfter: string; interaction: string; evidence: unknown[] }) {
    if (!input.stateBefore.trim() || !input.stateAfter.trim() || !input.interaction.trim()
      || !Array.isArray(input.evidence) || !input.evidence.length) {
      throw new TypeError("A shot prop needs before/after state, interaction and source evidence.");
    }
    const shot = this.db.query(`SELECT project_id FROM production_shot WHERE id = ?`).get(input.shotId) as
      | { project_id: string } | null;
    const ids = [input.propId, input.holderBeforeId, input.holderAfterId].filter((id): id is string => !!id);
    const assets = ids.map(id => this.db.query(`SELECT id, project_id AS projectId, kind FROM production_asset WHERE id = ?`)
      .get(id) as { id: string; projectId: string; kind: AssetKind } | null);
    if (!shot || !assets[0] || assets[0].kind !== "prop" || assets.some(asset => !asset || asset.projectId !== shot.project_id)
      || assets.slice(1).some(asset => asset?.kind !== "character")) {
      throw new Error("Shot prop and its holders must be assets of the correct kind in the same project.");
    }
    this.db.query(`INSERT INTO shot_prop_link(shot_id, prop_id, holder_before_id, holder_after_id,
      state_before, state_after, interaction, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shot_id, prop_id) DO UPDATE SET holder_before_id = excluded.holder_before_id,
      holder_after_id = excluded.holder_after_id, state_before = excluded.state_before,
      state_after = excluded.state_after, interaction = excluded.interaction, evidence_json = excluded.evidence_json`)
      .run(input.shotId, input.propId, input.holderBeforeId ?? null, input.holderAfterId ?? null,
        input.stateBefore.trim(), input.stateAfter.trim(), input.interaction.trim(), JSON.stringify(input.evidence));
  }

  addExtractedCandidate(input: { projectId: string; episodeId: string; shotId: string;
    kind: "character" | "scene" | "prop" | "costume" | "dialogue"; value: unknown; evidence: unknown[]; confidence: number }) {
    if (!Array.isArray(input.evidence) || input.evidence.length === 0 || !Number.isFinite(input.confidence)
      || input.confidence < 0 || input.confidence > 1) throw new TypeError("Candidates require source evidence and confidence from 0 to 1.");
    const id = randomUUID();
    this.db.query(`INSERT INTO extracted_candidate(id, project_id, episode_id, shot_id, kind, candidate_json,
      evidence_json, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.projectId, input.episodeId, input.shotId, input.kind, JSON.stringify(input.value),
        JSON.stringify(input.evidence), input.confidence, Date.now());
    return id;
  }

  resolveCandidate(candidateId: string, state: Exclude<CandidateState, "pending">, linkedEntityId?: string) {
    if (state === "linked" && !linkedEntityId?.trim()) throw new TypeError("Linking a candidate requires an entity ID.");
    const updated = this.db.query(`UPDATE extracted_candidate SET state = ?, linked_entity_id = ?
      WHERE id = ? AND state = 'pending'`).run(state, state === "linked" ? linkedEntityId! : null, candidateId);
    if (!updated.changes) throw new Error("Only a pending extraction candidate can be resolved.");
  }

  validateEpisodeForSynthesis(episodeId: string) {
    const shots = this.db.query(`SELECT id, sequence, scene_id AS sceneId, script_excerpt AS scriptExcerpt,
      review_state AS reviewState, video_readiness AS videoReadiness FROM production_shot
      WHERE episode_id = ? ORDER BY sequence`).all(episodeId) as Array<{
        id: string; sequence: number; sceneId: string | null; scriptExcerpt: string;
        reviewState: ReviewState; videoReadiness: VideoReadiness;
      }>;
    const characters = this.db.query(`SELECT COUNT(DISTINCT l.character_id) AS count FROM shot_character_link l
      JOIN production_shot s ON s.id = l.shot_id WHERE s.episode_id = ?`).get(episodeId) as { count: number };
    const scenes = new Set(shots.map((shot) => shot.sceneId).filter(Boolean));
    const issues: string[] = [];
    if (!shots.length) issues.push("Episode needs at least one shot.");
    if (shots.some((shot) => shot.reviewState !== "confirmed" || shot.videoReadiness !== "ready")) {
      issues.push("All shots must be confirmed and video-ready.");
    }
    if (shots.some((shot) => !shot.scriptExcerpt.trim())) issues.push("Every shot needs a script excerpt.");
    issues.push(...this.validatePropContinuity(episodeId));
    return { ready: issues.length === 0, issues, shotCount: shots.length, characterCount: characters.count, sceneCount: scenes.size };
  }

  validateAcceptanceEpisode(episodeId: string) {
    const report = this.validateEpisodeForSynthesis(episodeId);
    const issues = [...report.issues];
    if (report.shotCount < 8 || report.shotCount > 12) issues.push("Acceptance episode needs 8 to 12 shots.");
    if (report.characterCount < 2) issues.push("Acceptance episode needs at least two linked characters.");
    if (report.sceneCount < 3) issues.push("Acceptance episode needs at least three distinct scenes.");
    return { ...report, ready: issues.length === 0, issues };
  }

  validatePropContinuity(episodeId: string) {
    const episode = this.db.query(`SELECT project_id AS projectId, episode_number AS episodeNumber
      FROM production_episode WHERE id = ?`).get(episodeId) as { projectId: string; episodeNumber: number } | null;
    if (!episode) throw new Error(`Unknown episode: ${episodeId}`);
    const events = this.db.query(`SELECT s.episode_id AS episodeId, s.sequence, l.shot_id AS shotId,
      l.prop_id AS propId, p.name AS propName, l.holder_before_id AS holderBeforeId,
      l.holder_after_id AS holderAfterId, l.state_before AS stateBefore, l.state_after AS stateAfter
      FROM shot_prop_link l JOIN production_shot s ON s.id = l.shot_id
      JOIN production_episode e ON e.id = s.episode_id JOIN production_asset p ON p.id = l.prop_id
      WHERE e.project_id = ? AND e.episode_number <= ? ORDER BY e.episode_number, s.sequence`)
      .all(episode.projectId, episode.episodeNumber) as Array<{ episodeId: string; sequence: number;
        shotId: string; propId: string; propName: string; holderBeforeId: string | null;
        holderAfterId: string | null; stateBefore: string; stateAfter: string }>;
    const last = new Map<string, { stateAfter: string; holderAfterId: string | null }>();
    const issues: string[] = [];
    for (const event of events) {
      const previous = last.get(event.propId);
      if (event.episodeId === episodeId && previous) {
        if (previous.stateAfter !== event.stateBefore) {
          issues.push(`镜头 ${event.sequence} 的道具“${event.propName}”前态与上一镜头后态不一致。`);
        }
        if (previous.holderAfterId !== event.holderBeforeId) {
          issues.push(`镜头 ${event.sequence} 的道具“${event.propName}”持有人与上一镜头不一致。`);
        }
      }
      last.set(event.propId, { stateAfter: event.stateAfter, holderAfterId: event.holderAfterId });
    }
    return issues;
  }
}

/** Persist a validated Jellyfish-style structured draft atomically; this function never calls a model. */
export function applyEpisodeDraft(catalog: ProductionCatalog, projectId: string, draft: EpisodeDraft,
  origin?: { taskId: string; inputId: string; responseHash: string; validateCurrentInput: () => void }) {
  if (!projectId.trim() || !Number.isSafeInteger(draft.episodeNumber) || draft.episodeNumber < 1
    || !draft.title.trim() || !draft.logline.trim() || !draft.outline.length || !draft.script.length) {
    throw new TypeError("Episode draft is missing its identity, outline, or script.");
  }
  if (!draft.scenes.length || !draft.shots.length || draft.shots.length > 200) {
    throw new Error("An episode draft needs at least one scene and one shot, with at most 200 shots.");
  }
  const story = catalog.getStory(projectId);
  if (!story) throw new Error(`Unknown production story: ${projectId}`);
  if (story.sourceKind === "novel") {
    const sourceIndex = indexNovel(story.sourceText);
    if (!sourceIndex.chapters.length) throw new Error("小说尚未确认分章边界，不能采用自动分集草稿。");
    const evidenceLists: Array<[string, DraftEvidence[]]> = [
      ...draft.script.map((rawScene, index) => {
        const scene = rawScene && typeof rawScene === "object" && !Array.isArray(rawScene)
          ? rawScene as { evidence?: unknown } : null;
        const references = Array.isArray(scene?.evidence) ? scene.evidence as DraftEvidence[] : [];
        return [`剧本第 ${index + 1} 场`, references] as [string, DraftEvidence[]];
      }),
      ...draft.scenes.map(scene => [`场景“${scene.name}”`, scene.evidence] as [string, DraftEvidence[]]),
      ...draft.characters.map(character => [`人物“${character.name}”`, character.evidence] as [string, DraftEvidence[]]),
      ...(draft.props ?? []).map(prop => [`道具“${prop.name}”`, prop.evidence] as [string, DraftEvidence[]]),
      ...draft.shots.flatMap(shot => [
        [`镜头 ${shot.sequence}`, shot.evidence] as [string, DraftEvidence[]],
        ...(shot.propUses ?? []).map(use => [`镜头 ${shot.sequence} 道具“${use.name}”`, use.evidence] as [string, DraftEvidence[]]),
      ]),
    ];
    for (const [label, evidence] of evidenceLists) {
      if (!evidence.length) throw new Error(`${label}缺少原文证据。`);
      for (const value of evidence) {
        const check = checkSourceEvidence(story.sourceText, sourceIndex, value);
        if (!check.valid) throw new Error(`${label}的原文证据无效：${check.reason}`);
      }
    }
    const scriptReport = checkEpisodeScript(draft.script, sourceIndex.chapters);
    if (!scriptReport.passed) throw new Error(`小说改编剧本未通过基础检查：${scriptReport.checks[0]?.message}`);
  }
  const characterNames = new Map<string, string>();
  for (const character of draft.characters) {
    const key = character.name.trim().toLocaleLowerCase();
    if (!key || characterNames.has(key) || !character.stableDescription.trim() || !character.evidence.length) {
      throw new Error("Character names must be unique and include descriptions and source evidence.");
    }
    characterNames.set(key, key);
    for (const alias of character.aliases) {
      const aliasKey = alias.trim().toLocaleLowerCase();
      if (!aliasKey || characterNames.has(aliasKey) && characterNames.get(aliasKey) !== key) {
        throw new Error(`Character alias conflicts with another identity: ${alias}`);
      }
      characterNames.set(aliasKey, key);
    }
  }
  const sceneNames = new Map<string, string>();
  for (const scene of draft.scenes) {
    const key = scene.name.trim().toLocaleLowerCase();
    if (!key || sceneNames.has(key) || !scene.evidence.length) throw new Error("Scene names must be unique and include source evidence.");
    sceneNames.set(key, scene.name);
  }
  const propNames = new Map<string, string>();
  for (const prop of draft.props ?? []) {
    const key = prop.name.trim().toLocaleLowerCase();
    if (!key || propNames.has(key) || !prop.stableDescription.trim() || !prop.evidence.length) {
      throw new Error("Prop names must be unique and include descriptions and source evidence.");
    }
    propNames.set(key, key);
    for (const alias of prop.aliases) {
      const aliasKey = alias.trim().toLocaleLowerCase();
      if (!aliasKey || propNames.has(aliasKey) && propNames.get(aliasKey) !== key) {
        throw new Error(`Prop alias conflicts with another identity: ${alias}`);
      }
      propNames.set(aliasKey, key);
    }
  }
  const sequences = new Set<number>();
  for (const shot of draft.shots) {
    if (!Number.isSafeInteger(shot.sequence) || shot.sequence < 1 || sequences.has(shot.sequence)
      || !shot.scriptExcerpt.trim() || !shot.evidence.length || !Number.isSafeInteger(shot.durationMs) || shot.durationMs < 1
      || !sceneNames.has(shot.sceneName.trim().toLocaleLowerCase())) {
      throw new Error("Each shot needs a unique sequence, scene, script evidence and duration.");
    }
    sequences.add(shot.sequence);
    for (const name of shot.characterNames) if (!characterNames.has(name.trim().toLocaleLowerCase())) {
      throw new Error(`Shot references an unknown character: ${name}`);
    }
    const usedProps = new Set<string>();
    for (const use of shot.propUses ?? []) {
      const key = propNames.get(use.name.trim().toLocaleLowerCase());
      if (!key || usedProps.has(key) || !use.stateBefore.trim() || !use.stateAfter.trim()
        || !use.interaction.trim() || !use.evidence.length) {
        throw new Error("Shot prop use needs a known unique prop, before/after state, interaction and evidence.");
      }
      usedProps.add(key);
      for (const holder of [use.holderBeforeName, use.holderAfterName]) {
        if (holder && !characterNames.has(holder.trim().toLocaleLowerCase())) {
          throw new Error(`Shot prop use references an unknown character holder: ${holder}`);
        }
      }
    }
    for (const line of shot.dialogue) {
      if (!line.text.trim() || (line.kind === "dialogue" && (!line.speakerName
        || !characterNames.has(line.speakerName.trim().toLocaleLowerCase())))) {
        throw new Error("Dialogue lines must contain text and native dialogue must resolve a character speaker.");
      }
      if (line.listenerName && !characterNames.has(line.listenerName.trim().toLocaleLowerCase())) {
        throw new Error(`Dialogue references an unknown listener: ${line.listenerName}`);
      }
    }
  }

  return catalog.withTransaction(() => {
    origin?.validateCurrentInput();
    const sceneIds = new Map<string, string>();
    for (const scene of draft.scenes) {
      const existing = catalog.db.query(`SELECT id, locked, location, atmosphere, time_weather AS timeWeather
        FROM production_scene WHERE project_id = ? AND canonical_name = ?`)
        .get(projectId, scene.name.trim().toLocaleLowerCase()) as
          | { id: string; locked: number; location: string; atmosphere: string; timeWeather: string } | null;
      if (existing?.locked && (existing.location !== scene.location || existing.atmosphere !== scene.atmosphere
        || existing.timeWeather !== scene.timeWeather)) {
        throw new Error(`Locked scene appearance conflicts with draft: ${scene.name}`);
      }
      const id = existing?.locked ? existing.id : catalog.upsertScene({ projectId, ...scene });
      sceneIds.set(scene.name.trim().toLocaleLowerCase(), id);
    }
    const characterIds = new Map<string, string>();
    for (const character of draft.characters) {
      const existing = catalog.db.query(`SELECT id, locked, stable_description AS stableDescription FROM production_asset
        WHERE project_id = ? AND kind = 'character' AND canonical_name = ?`)
        .get(projectId, character.name.trim().toLocaleLowerCase()) as
          | { id: string; locked: number; stableDescription: string } | null;
      if (existing && existing.stableDescription !== character.stableDescription) {
        throw new Error(`Character appearance conflicts with prior episodes; create a variant: ${character.name}`);
      }
      const id = existing?.locked ? existing.id : catalog.upsertAsset({ projectId, kind: "character", ...character });
      characterIds.set(character.name.trim().toLocaleLowerCase(), id);
    }
    const propIds = new Map<string, string>();
    for (const prop of draft.props ?? []) {
      const existing = catalog.db.query(`SELECT id, locked, stable_description AS stableDescription FROM production_asset
        WHERE project_id = ? AND kind = 'prop' AND canonical_name = ?`)
        .get(projectId, prop.name.trim().toLocaleLowerCase()) as
          | { id: string; locked: number; stableDescription: string } | null;
      if (existing && existing.stableDescription !== prop.stableDescription) {
        throw new Error(`Prop appearance conflicts with prior episodes; create a variant: ${prop.name}`);
      }
      const id = existing?.locked ? existing.id : catalog.upsertAsset({ projectId, kind: "prop", ...prop });
      propIds.set(prop.name.trim().toLocaleLowerCase(), id);
    }
    const episodeId = catalog.createEpisode(projectId, draft.episodeNumber, draft.title, draft.logline);
    catalog.saveEpisodeOutline(episodeId, draft.outline);
    catalog.saveEpisodeScript(episodeId, draft.script);
    const shotIds: string[] = [];
    for (const shot of draft.shots) {
      const shotId = catalog.createShot({ projectId, episodeId, sequence: shot.sequence,
        sceneId: sceneIds.get(shot.sceneName.trim().toLocaleLowerCase()), title: shot.title,
        scriptExcerpt: shot.scriptExcerpt, evidence: shot.evidence, durationMs: shot.durationMs,
        shotSize: shot.shotSize, movement: shot.movement });
      shotIds.push(shotId);
      if (shot.promptText.trim()) catalog.setShotPrompt(shotId, shot.promptText);
      for (const name of shot.characterNames) catalog.linkCharacterToShot(shotId,
        characterIds.get(characterNames.get(name.trim().toLocaleLowerCase())!)!);
      for (const use of shot.propUses ?? []) {
        catalog.linkPropToShot({ shotId, propId: propIds.get(propNames.get(use.name.trim().toLocaleLowerCase())!)!,
          holderBeforeId: use.holderBeforeName ? characterIds.get(characterNames.get(use.holderBeforeName.trim().toLocaleLowerCase())!) : undefined,
          holderAfterId: use.holderAfterName ? characterIds.get(characterNames.get(use.holderAfterName.trim().toLocaleLowerCase())!) : undefined,
          stateBefore: use.stateBefore, stateAfter: use.stateAfter, interaction: use.interaction, evidence: use.evidence });
      }
      for (const [index, line] of shot.dialogue.entries()) {
        catalog.addDialogue({ shotId, sequence: index + 1, kind: line.kind,
          speakerId: line.speakerName ? characterIds.get(characterNames.get(line.speakerName.trim().toLocaleLowerCase())!) : undefined,
          listenerId: line.listenerName ? characterIds.get(characterNames.get(line.listenerName.trim().toLocaleLowerCase())!) : undefined,
          text: line.text, emotion: line.emotion, voiceProfile: line.voiceProfile });
      }
    }
    if (origin) catalog.db.query(`INSERT INTO adaptation_adoption(task_id, input_id, response_hash, episode_id, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(origin.taskId, origin.inputId, origin.responseHash, episodeId, Date.now());
    return { episodeId, shotIds, characterIds: [...characterIds.values()], sceneIds: [...sceneIds.values()],
      propIds: [...propIds.values()], awaitingReview: true };
  });
}

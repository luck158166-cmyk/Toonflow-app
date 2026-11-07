import { createHash, randomUUID } from "node:crypto";
import type { ProductionCatalog } from "./catalog";
import { getShotPreparation, type ShotReferenceSlot } from "./shotPreparation";
import { compilePreparedShot, renderVideoPrompt } from "./shotPrompt";
import { validateShotSceneContext } from "./shotDirection";

type PreparedShot = ReturnType<typeof getShotPreparation>;
type Check = { code: string; state: "passed" | "failed" | "pending"; message: string };

function compileSegment(inputs: PreparedShot[]) {
  const characters = [...new Set(inputs.flatMap(input => input.snapshot.characters.map(item => item.id)))];
  const allReferences = new Map<string, ShotReferenceSlot>();
  for (const input of inputs) for (const slot of input.snapshot.references) allReferences.set(`${slot.entityId}:${slot.role}`, slot);
  const rank = (slot: ShotReferenceSlot) => {
    if (slot.role === "headshot" || slot.role === "fullBody") return characters.indexOf(slot.entityId) * 2 + (slot.role === "headshot" ? 0 : 1);
    return characters.length * 2 + ({ costume: 0, scene: 1, prop: 2 } as const)[slot.role];
  };
  const references = [...allReferences.values()].sort((a, b) => rank(a) - rank(b)).map((slot, index) => ({ ...slot, index: index + 1 }));
  const checks: Check[] = []; const frames: string[] = [];
  let duration = 0;
  const timeline = inputs.map(input => {
    const compiled = compilePreparedShot(input, duration);
    frames.push(compiled.frame);
    checks.push(...compiled.snapshot.checks.filter(item => !["P04", "P12", "P18"].includes(item.code))
      .map(item => ({ ...item, message: item.state === "failed" ? `镜头 ${input.snapshot.shot.sequence}：${item.message}` : item.message })));
    const start = duration; duration += input.snapshot.shot.durationMs / 1000;
    return { shotId: input.snapshot.shot.id, sequence: input.snapshot.shot.sequence, title: input.snapshot.shot.title, start, end: duration };
  });
  const first = inputs[0]!.snapshot.shot;
  const prompt = renderVideoPrompt(references, characters.length,
    inputs.map(input => input.snapshot.shot.direction?.summary ?? "").join("；"), frames,
    first.direction?.environment ?? "", first.direction?.style ?? "");
  const timingValid = timeline.every(item => Number.isInteger(item.start) && Number.isInteger(item.end) && item.end > item.start)
    && duration >= 4 && duration <= 30;
  const countValid = characters.length <= 5 && references.filter(item => ["headshot", "fullBody"].includes(item.role)).length <= 8 && references.length <= 30;
  const lengthValid = [...prompt].length <= 4000;
  checks.push({ code: "P04", state: timingValid ? "passed" : "failed", message: "片段须为 4–30 秒，每镜整数秒连续排列，不补帧或静默改时长" },
    { code: "P12", state: countValid ? "passed" : "failed", message: "片段整体人物及参考图数量符合项目保守上限" },
    { code: "P18", state: lengthValid ? "passed" : "failed", message: "片段完整提示词不得超过 4000 字符" });
  return { sceneSequence: first.sceneContext?.sceneSequence ?? null,
    boundaryReason: first.sceneContext?.isolate ? first.sceneContext.reason : "同场次、同画风与环境；按时长和素材上限划分",
    timeline, references, requestDraft: { model: "doubao-seedance-2-5-260628", duration, ratio: "9:16", resolution: "1080p", generateAudio: true, prompt },
    checks: [...new Map(checks.map(item => [JSON.stringify(item), item])).values()],
    shapeValid: timingValid && countValid && lengthValid };
}

function mayCombine(left: PreparedShot, right: PreparedShot) {
  const a = left.snapshot.shot; const b = right.snapshot.shot;
  return !!a.sceneContext && !!b.sceneContext && !a.sceneContext.isolate && !b.sceneContext.isolate
    && [a, b].every(shot => Number.isInteger(shot.durationMs / 1000) && shot.durationMs >= 1000 && shot.durationMs <= 30000)
    && a.sceneContext.sceneSequence === b.sceneContext.sceneSequence && a.sceneId === b.sceneId
    && b.sequence === a.sequence + 1 && !!a.direction && !!b.direction
    && a.direction.style === b.direction.style && a.direction.environment === b.direction.environment;
}

/** Bounded dynamic partitioning avoids leaving an invalid 1–3 second tail. Never drops or reorders a shot. */
export function getEpisodeSegmentPlan(catalog: ProductionCatalog, projectId: string, episodeId: string) {
  const project = catalog.getProjectProduction(projectId);
  const episode = project.episodes.find(item => item.id === episodeId);
  if (!episode) throw new Error("当前故事没有这个分集");
  const shots = project.shots.filter(item => item.episodeId === episodeId);
  if (!shots.length) throw new Error("本集没有分镜");
  const inputs = shots.map(shot => getShotPreparation(catalog, projectId, shot.id));
  let previousScene = 0;
  for (const input of inputs) {
    const shot = input.snapshot.shot;
    try {
      validateShotSceneContext(shot.sceneContext, episode.script, project.scenes.find(item => item.id === shot.sceneId)?.name ?? "");
      if (shot.sceneContext!.sceneSequence < previousScene) throw new Error("镜头场次次序倒退，请修正场次归属");
      previousScene = shot.sceneContext!.sceneSequence;
    } catch (cause) { input.issues.push({ code: "sceneContext", message: cause instanceof Error ? cause.message : "场次归属无效" }); }
  }
  const cost = Array<number>(inputs.length + 1).fill(Infinity); cost[inputs.length] = 0;
  const choice = new Map<number, { end: number; segment: ReturnType<typeof compileSegment> }>();
  for (let start = inputs.length - 1; start >= 0; start--) {
    let duration = 0;
    for (let end = start; end < inputs.length; end++) {
      if (end > start && !mayCombine(inputs[end - 1]!, inputs[end]!)) break;
      duration += inputs[end]!.snapshot.shot.durationMs / 1000;
      if (end > start && duration > 30) break;
      const segment = compileSegment(inputs.slice(start, end + 1));
      if (!segment.shapeValid && end > start) continue;
      // Prefer 8–15 seconds near 12. Invalid single shots stay visible instead of being omitted.
      const candidateCost = cost[end + 1]! + (segment.shapeValid ? 10 + Math.abs(duration - 12) + (duration > 15 ? 100 : 0) : 100000);
      if (candidateCost < cost[start]!) { cost[start] = candidateCost; choice.set(start, { end: end + 1, segment }); }
    }
  }
  const segments: Array<ReturnType<typeof compileSegment> & { sequence: number }> = [];
  for (let index = 0; index < inputs.length;) {
    const selected = choice.get(index)!;
    segments.push({ ...selected.segment, sequence: segments.length + 1 }); index = selected.end;
  }
  const snapshot = { templateVersion: "seedance25Segments.v1", projectId, episodeId,
    inputs: inputs.map(input => ({ inputHash: input.inputHash, snapshot: input.snapshot })), segments };
  const inputHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  const history = catalog.db.query(`SELECT id, version, input_hash AS inputHash, created_at AS createdAt FROM episode_segment_plan
    WHERE project_id = ? AND episode_id = ? ORDER BY version DESC`).all(projectId, episodeId) as Array<{ id: string; version: number; inputHash: string; createdAt: number }>;
  return { inputHash, snapshot, history, canSave: segments.every(segment => segment.checks.every(item => item.state !== "failed")),
    readyForGeneration: false as const };
}

/** Host verifies every original image before saving. No generation task or readiness mutation. */
export function saveEpisodeSegmentPlan(catalog: ProductionCatalog, projectId: string, episodeId: string, expectedHash: string) {
  return catalog.withTransaction(() => {
    const current = getEpisodeSegmentPlan(catalog, projectId, episodeId);
    if (current.inputHash !== expectedHash) throw new Error("剧本、镜头或参考图已变化，请重新规划");
    if (!current.canSave) throw new Error("片段仍有未解决的检查项，不能保存");
    const existing = current.history.find(item => item.inputHash === expectedHash);
    if (existing) return { ...existing, created: false };
    const id = randomUUID(); const version = (current.history[0]?.version ?? 0) + 1; const createdAt = Date.now();
    catalog.db.query(`INSERT INTO episode_segment_plan(id, project_id, episode_id, input_hash, version, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, projectId, episodeId, expectedHash, version, JSON.stringify(current.snapshot), createdAt);
    return { id, version, inputHash: expectedHash, createdAt, created: true };
  });
}

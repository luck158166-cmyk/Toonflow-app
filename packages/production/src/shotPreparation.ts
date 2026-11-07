import { createHash, randomUUID } from "node:crypto";
import type { ProductionCatalog } from "./catalog";
import { getEpisodeReview } from "./episodeReview";
import { listAssetReferences, listReferenceTargets, type ReferenceRole, type AssetReference } from "./assetReference";

export type PreparationIssue = { code: string; message: string; entityId?: string };
export type ShotReferenceSlot = { index: number; entityId: string; name: string; role: ReferenceRole;
  description: string; reference: AssetReference | null };
const preparationVersion = "shotPreparation1";

/** Resolve production facts and exact original-image versions, without generating or authorizing media. */
export function getShotPreparation(catalog: ProductionCatalog, projectId: string, shotId: string) {
  const project = catalog.getProjectProduction(projectId);
  const selected = project.shots.find(item => item.id === shotId);
  if (!selected) throw new Error("当前故事没有这个镜头");
  const review = getEpisodeReview(catalog, projectId, selected.episodeId);
  const { snapshot } = review;
  const shot = snapshot.shots.find(item => item.id === shotId)!;
  const issues: PreparationIssue[] = review.issues.map(message => ({ code: "content", message }));
  if (snapshot.episode.reviewState !== "confirmed" || shot.reviewState !== "confirmed") {
    issues.push({ code: "review", message: "请先在分集审核中确认剧本和镜头内容" });
  }
  const targets = listReferenceTargets(catalog, projectId);
  const references = listAssetReferences(catalog, projectId);
  // Preserve the draft's declared character order, then prioritize explicit first mentions in this shot.
  const links = catalog.db.query(`SELECT character_id AS characterId, costume_id AS costumeId
    FROM shot_character_link WHERE shot_id = ? ORDER BY rowid`).all(shotId) as Array<{ characterId: string; costumeId: string | null }>;
  const firstMention = (id: string) => {
    const asset = snapshot.assets.find(item => item.id === id);
    const positions = asset ? [asset.name, ...asset.aliases].filter(name => name.trim()).map(name => shot.scriptExcerpt.indexOf(name)).filter(index => index >= 0) : [];
    return positions.length ? Math.min(...positions) : Number.MAX_SAFE_INTEGER;
  };
  links.sort((left, right) => firstMention(left.characterId) - firstMention(right.characterId));
  const slots: ShotReferenceSlot[] = [];
  const add = (entityId: string, role: ReferenceRole) => {
    if (slots.some(item => item.entityId === entityId && item.role === role)) return;
    const target = targets.find(item => item.entityId === entityId);
    const reference = references.find(item => item.entityId === entityId && item.role === role) ?? null;
    const name = target?.name ?? "未知资产";
    slots.push({ index: slots.length + 1, entityId, name, role, description: target?.description ?? "", reference });
    if (!target || !target.roles.includes(role) || !target.locked) issues.push({ code: "asset", entityId, message: `${name}的描述未锁定或资产用途不匹配` });
    if (!reference) issues.push({ code: "missingReference", entityId, message: `${name}缺少${roleLabel(role)}` });
    else if (reference.entityHash !== target?.entityHash) issues.push({ code: "staleReference", entityId, message: `${name}的${roleLabel(role)}与当前描述不一致，请重新核对绑定` });
  };
  for (const link of links) { add(link.characterId, "headshot"); add(link.characterId, "fullBody"); }
  for (const link of links) if (link.costumeId) add(link.costumeId, "costume");
  if (shot.sceneId) add(shot.sceneId, "scene");
  const props = snapshot.props.filter(item => item.shotId === shotId);
  for (const prop of props) add(prop.propId, "prop");
  const dialogue = snapshot.dialogue.filter(item => item.shotId === shotId).map(line => ({ ...line,
    speakerName: snapshot.assets.find(item => item.id === line.speakerId)?.name ?? null,
    listenerName: snapshot.assets.find(item => item.id === line.listenerId)?.name ?? null }));
  for (const line of dialogue) {
    if (line.kind === "dialogue" && !links.some(item => item.characterId === line.speakerId)) {
      issues.push({ code: "speaker", entityId: line.speakerId ?? undefined, message: "对白说话人没有关联到本镜头出场人物" });
    }
  }
  // ACT: use the existing script estimator's 4 characters/second default until calibrated voice timing is available.
  const dialogueTiming = { charactersPerSecond: 4, estimatedSeconds: dialogue.reduce((sum, line) => sum + [...line.text.replace(/\s/g, "")].length, 0) / 4 };
  if (dialogueTiming.estimatedSeconds * 1000 > shot.durationMs) issues.push({ code: "dialogueDuration",
    message: `本镜对白粗估 ${dialogueTiming.estimatedSeconds.toFixed(1)} 秒，超过镜头 ${shot.durationMs / 1000} 秒；请调整对白或分镜时长` });
  const characterNames = links.map(link => ({ id: link.characterId,
    name: snapshot.assets.find(item => item.id === link.characterId)?.name ?? "未知角色", costumeId: link.costumeId }));
  // Carry the last observed state even across episode boundaries; absence between shots does not reset a prop.
  const earlierIds = new Set(project.shots.filter(item => item.episodeNumber < selected.episodeNumber
    || item.episodeNumber === selected.episodeNumber && item.sequence < selected.sequence).map(item => item.id));
  const priorProps = props.map(prop => {
    const preceding = project.shots.filter(item => earlierIds.has(item.id)).flatMap(item => project.shotProps.filter(use => use.shotId === item.id && use.propId === prop.propId));
    const previous = preceding.at(-1) ?? null;
    if (previous && (previous.holderAfterId !== prop.holderBeforeId || previous.stateAfter !== prop.stateBefore)) {
      issues.push({ code: "propContinuity", entityId: prop.propId, message: `${prop.propName}的持有人或状态与前次出现的结尾不一致` });
    }
    return { propId: prop.propId, previous };
  });
  const position = snapshot.shots.findIndex(item => item.id === shotId);
  const input = { templateVersion: preparationVersion, projectId, episodeId: selected.episodeId,
    sourceHash: snapshot.sourceHash, episodeReviewHash: review.snapshotHash,
    shot, characters: characterNames, dialogue, dialogueTiming, props, references: slots,
    continuity: { previousShot: snapshot.shots[position - 1] ?? null, nextShot: snapshot.shots[position + 1] ?? null, priorProps } };
  const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const history = catalog.db.query(`SELECT id, version, input_hash AS inputHash, created_at AS createdAt
    FROM shot_preparation WHERE project_id = ? AND shot_id = ? ORDER BY version DESC`)
    .all(projectId, shotId) as Array<{ id: string; version: number; inputHash: string; createdAt: number }>;
  return { inputHash, snapshot: input, issues, history };
}

function roleLabel(role: ReferenceRole) {
  return { headshot: "面部图", fullBody: "全身妆造图", costume: "服装图", scene: "场景图", prop: "道具图" }[role];
}

/** Host verifies original bytes before calling; future paid submission must recheck them again. */
export function saveShotPreparation(catalog: ProductionCatalog, projectId: string, shotId: string, expectedHash: string) {
  return catalog.withTransaction(() => {
    const current = getShotPreparation(catalog, projectId, shotId);
    if (current.inputHash !== expectedHash) throw new Error("镜头或参考图版本已变化，请刷新后重新检查");
    if (current.issues.length) throw new Error(current.issues[0]!.message);
    const existing = current.history.find(item => item.inputHash === expectedHash);
    if (existing) return { ...existing, created: false };
    const id = randomUUID(); const version = (current.history[0]?.version ?? 0) + 1; const createdAt = Date.now();
    catalog.db.query(`INSERT INTO shot_preparation(id, project_id, episode_id, shot_id, input_hash, version, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, projectId, current.snapshot.episodeId, shotId,
      expectedHash, version, JSON.stringify(current.snapshot), createdAt);
    return { id, version, inputHash: expectedHash, createdAt, created: true };
  });
}

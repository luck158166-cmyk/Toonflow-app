import { createHash, randomUUID } from "node:crypto";
import type { ProductionCatalog } from "./catalog";

export type ReferenceRole = "headshot" | "fullBody" | "scene" | "prop" | "costume";
export type AssetReference = { id: string; projectId: string; entityKind: "asset" | "scene"; entityId: string;
  entityHash: string; role: ReferenceRole; version: number; previousId: string | null; path: string;
  sha256: string; mimeType: string; width: number; height: number; sourceNote: string;
  sourceKind: "user_authorized"; createdAt: number };
export type ReferenceTarget = { entityKind: "asset" | "scene"; entityId: string; name: string; kind: string;
  description: string; locked: boolean; entityHash: string; roles: ReferenceRole[] };

export function listAssetReferences(catalog: ProductionCatalog, projectId: string): AssetReference[] {
  return catalog.db.query(`SELECT id, project_id AS projectId, entity_kind AS entityKind, entity_id AS entityId,
    entity_hash AS entityHash, role, version, previous_id AS previousId, path, sha256, mime_type AS mimeType,
    width, height, source_note AS sourceNote, source_kind AS sourceKind, created_at AS createdAt
    FROM asset_reference WHERE project_id = ? ORDER BY version DESC, id`).all(projectId) as AssetReference[];
}

export function listReferenceTargets(catalog: ProductionCatalog, projectId: string): ReferenceTarget[] {
  if (!catalog.getStory(projectId)) throw new Error("当前工作区没有这个故事");
  const project = catalog.getProjectProduction(projectId);
  const targets = [
    ...project.assets.map(asset => ({ entityKind: "asset" as const, entityId: asset.id, name: asset.name,
      kind: asset.kind, description: asset.stableDescription, locked: asset.locked,
      roles: (asset.kind === "character" ? ["headshot", "fullBody"] : [asset.kind]) as ReferenceRole[],
      facts: { name: asset.name, kind: asset.kind, description: asset.stableDescription, aliases: asset.aliases, variantOf: asset.variantOf } })),
    ...project.scenes.map(scene => ({ entityKind: "scene" as const, entityId: scene.id, name: scene.name,
      kind: "scene", description: [scene.location, scene.atmosphere, scene.timeWeather].filter(Boolean).join(" · "),
      locked: scene.locked, roles: ["scene"] as ReferenceRole[],
      facts: { name: scene.name, location: scene.location, atmosphere: scene.atmosphere, timeWeather: scene.timeWeather } })),
  ];
  return targets.map(({ facts, ...target }) => ({ ...target,
    entityHash: createHash("sha256").update(JSON.stringify(facts)).digest("hex") }));
}

export type BindReferenceInput = { projectId: string; entityKind: "asset" | "scene"; entityId: string;
  entityHash: string; role: ReferenceRole; expectedReferenceId: string | null; rightsConfirmed: true;
  sourceNote: string; file: { path: string; sha256: string; mimeType: string; width: number; height: number } };

/** File metadata comes only from the host's validated, preserved original bytes. */
export function bindAssetReference(catalog: ProductionCatalog, input: BindReferenceInput) {
  if (input.rightsConfirmed !== true || !input.sourceNote.trim() || input.sourceNote.length > 2000) throw new Error("请确认图片使用权并记录来源");
  const file = input.file;
  if (!/^[a-f0-9]{64}$/.test(file.sha256) || !["image/png", "image/jpeg", "image/webp"].includes(file.mimeType)
    || !Number.isSafeInteger(file.width) || !Number.isSafeInteger(file.height) || file.width < 1 || file.height < 1
    || file.width > 8192 || file.height > 8192 || file.width * file.height > 40_000_000
    || file.path !== `assets/productionReferences/${file.sha256}.${({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>)[file.mimeType]}`) throw new Error("参考图文件信息无效");
  return catalog.withTransaction(() => {
    const target = listReferenceTargets(catalog, input.projectId)
      .find(item => item.entityKind === input.entityKind && item.entityId === input.entityId);
    if (!target || !target.roles.includes(input.role)) throw new Error("当前故事的资产或参考用途不匹配");
    if (!target.locked) throw new Error("请先在分集审核中确认并锁定资产描述");
    if (target.entityHash !== input.entityHash) throw new Error("资产描述已变化，请刷新后重新核对图片");
    const current = listAssetReferences(catalog, input.projectId).find(item =>
      item.entityKind === input.entityKind && item.entityId === input.entityId && item.role === input.role);
    if (current && current.sha256 === file.sha256 && current.entityHash === input.entityHash
      && current.sourceNote === input.sourceNote.trim()
      && (current.id === input.expectedReferenceId || current.previousId === input.expectedReferenceId)) {
      return { reference: current, created: false };
    }
    if ((current?.id ?? null) !== input.expectedReferenceId) throw new Error("参考图版本已变化，请刷新并确认要替换的图片");
    const id = randomUUID();
    catalog.db.query(`INSERT INTO asset_reference(id, project_id, entity_kind, entity_id, entity_hash, role,
      version, previous_id, path, sha256, mime_type, width, height, source_note, source_kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user_authorized', ?)`)
      .run(id, input.projectId, input.entityKind, input.entityId, input.entityHash, input.role,
        (current?.version ?? 0) + 1, current?.id ?? null, file.path, file.sha256, file.mimeType,
        file.width, file.height, input.sourceNote.trim(), Date.now());
    return { reference: listAssetReferences(catalog, input.projectId).find(item => item.id === id)!, created: true };
  });
}

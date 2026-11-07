import { getShotPreparation, getEpisodeSegmentPlan, type ProductionCatalog, type ShotReferenceSlot, type PreparationIssue } from "@toonflow/production";
import { readPreservedReference } from "./referenceImage";

export async function inspectShotPreparation(directory: string, catalog: ProductionCatalog, projectId: string, shotId: string) {
  const report = getShotPreparation(catalog, projectId, shotId);
  report.issues.push(...await inspectReferences(directory, report.snapshot.references));
  return report;
}

export async function inspectEpisodeSegmentPlan(directory: string, catalog: ProductionCatalog, projectId: string, episodeId: string) {
  const report = getEpisodeSegmentPlan(catalog, projectId, episodeId);
  const slots = [...new Map(report.snapshot.segments.flatMap(segment => segment.references).map(slot => [slot.reference?.id ?? slot.entityId, slot])).values()];
  const fileIssues = await inspectReferences(directory, slots);
  return { ...report, fileIssues, canSave: report.canSave && !fileIssues.length };
}

async function inspectReferences(directory: string, slots: ShotReferenceSlot[]) {
  const issues: PreparationIssue[] = [];
  const verified = new Map<string, boolean>();
  for (const slot of slots) {
    if (!slot.reference) continue;
    const key = JSON.stringify([slot.reference.path, slot.reference.sha256]);
    if (!verified.has(key)) {
      try { await readPreservedReference(directory, slot.reference); verified.set(key, true); }
      catch { verified.set(key, false); }
    }
    if (!verified.get(key)) issues.push({ code: "referenceBytes", entityId: slot.entityId,
      message: `${slot.name}的第 ${slot.index} 张参考原图缺失、被改动或暂不可读` });
  }
  return issues;
}

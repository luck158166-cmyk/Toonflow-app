import { getShotPreparation, type ProductionCatalog } from "@toonflow/production";
import { readPreservedReference } from "./referenceImage";

export async function inspectShotPreparation(directory: string, catalog: ProductionCatalog, projectId: string, shotId: string) {
  const report = getShotPreparation(catalog, projectId, shotId);
  const verified = new Map<string, boolean>();
  for (const slot of report.snapshot.references) {
    if (!slot.reference) continue;
    const key = JSON.stringify([slot.reference.path, slot.reference.sha256]);
    if (!verified.has(key)) {
      try { await readPreservedReference(directory, slot.reference); verified.set(key, true); }
      catch { verified.set(key, false); }
    }
    if (!verified.get(key)) report.issues.push({ code: "referenceBytes", entityId: slot.entityId,
      message: `${slot.name}的第 ${slot.index} 张参考原图缺失、被改动或暂不可读` });
  }
  return report;
}

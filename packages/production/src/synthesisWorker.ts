import { ProductionStore, type EpisodeRenderSpec } from "./store";
import type { EpisodeQualityReport } from "./episodeQuality";

export interface SynthesisPort {
  render(spec: EpisodeRenderSpec): Promise<{ sha256: string; quality?: EpisodeQualityReport; qualityReportPath?: string }>;
}

export async function runSynthesisTask(store: ProductionStore, taskId: string, synthesizer: SynthesisPort) {
  const task = store.getTask(taskId);
  if (task.stage !== "synthesis" || task.provider !== "local-synth") throw new Error("Task is not a local synthesis job.");
  const exportRecord = store.getSynthesisExport(taskId);
  if (!exportRecord) throw new Error("Synthesis manifest is missing.");
  if (task.state === "reconcile_required" || task.state === "failed") store.retryLocalSynthesis(taskId);
  const start = store.beginSubmission(taskId);
  if (start.status !== "started" && start.status !== "warning_90") return { status: start.status as "already_succeeded" | "already_dispatched" | "not_queued" | "budget_exhausted", task: start.task };
  try {
    const rendered = await synthesizer.render(exportRecord.spec);
    return { status: "succeeded" as const,
      quality: rendered.quality, qualityReportPath: rendered.qualityReportPath,
      result: store.completeTask(taskId, { slot: "episode", path: exportRecord.spec.outputPath, sha256: rendered.sha256 }) };
  } catch (error) {
    return { status: "failed" as const, task: store.failTask(taskId), error };
  }
}

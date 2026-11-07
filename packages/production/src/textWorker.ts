import { ProductionStore, type Task } from "./store";

export interface TextGenerationPort {
  readonly providerId: string;
  generate(task: Task): Promise<{ responseText: string; providerRequestId: string; usageJson: string }>;
}

/** Uses the same budget reservation and ambiguous-failure rules as media tasks. */
export async function runTextTask(store: ProductionStore, taskId: string, provider: TextGenerationPort) {
  const task = store.getTask(taskId);
  if (task.stage !== "text" || task.provider !== provider.providerId) throw new Error("Text provider or task stage mismatch.");
  if (task.state === "succeeded") return { status: "already_succeeded" as const, output: store.getTextOutput(taskId) };
  const started = store.beginSubmission(taskId);
  if (started.status !== "started" && started.status !== "warning_90") return { status: started.status };
  try {
    const response = await provider.generate(started.task);
    const output = store.completeTextTask(taskId, response);
    // Cost settlement is separate; unknown actual cost keeps the reservation active.
    return { status: "succeeded" as const, output };
  } catch (cause) {
    store.markReconciliationRequired(taskId);
    return { status: "reconcile_required" as const, error: cause };
  }
}

import { ProductionStore, type Task, type DispatchResult, type PricedTaskInput, type TextTaskAuthorization } from "./store";

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
  return finishTextSubmission(store, started, provider);
}

export async function runPricedTextTask(store: ProductionStore, input: PricedTaskInput,
  authorization: TextTaskAuthorization, provider: TextGenerationPort) {
  if (input.stage !== "text" || input.provider !== provider.providerId) throw new Error("Text provider or task stage mismatch.");
  return finishTextSubmission(store, store.createPricedTaskAndBeginSubmission(input, authorization), provider);
}

async function finishTextSubmission(store: ProductionStore, started: DispatchResult, provider: TextGenerationPort) {
  const taskId = started.task.id;
  if (started.status !== "started" && started.status !== "warning_90") return { status: started.status, taskId };
  try {
    const response = await provider.generate(started.task);
    const output = store.completeTextTask(taskId, response);
    // Cost settlement is separate; unknown actual cost keeps the reservation active.
    return { status: "succeeded" as const, taskId, output };
  } catch (cause) {
    store.markReconciliationRequired(taskId);
    return { status: "reconcile_required" as const, taskId, error: cause };
  }
}

import { ProductionStore, type DispatchResult, type Task, type TaskInput } from "./store";

/** Provider-specific HTTP code implements this port. The store and dispatcher stay provider-neutral. */
export interface ProviderSubmissionPort {
  readonly providerId: string;
  submit(task: Task): Promise<{ providerTaskId: string }>;
}

export type DispatchOutcome =
  | { status: "accepted"; task: Task }
  | { status: "budget_exhausted" | "already_succeeded" | "already_dispatched" | "not_queued"; task: Task }
  | { status: "reconcile_required"; task: Task; error: unknown };

/**
 * Persists dispatch intent before calling the injected provider. Any ambiguous
 * failure is moved to reconciliation and can never silently trigger a retry.
 */
export async function dispatchTask(
  store: ProductionStore,
  taskId: string,
  provider: ProviderSubmissionPort,
): Promise<DispatchOutcome> {
  const current = store.getTask(taskId);
  if (current.provider !== provider.providerId) throw new Error("Task provider does not match the selected adapter.");

  return submitStarted(store, store.beginSubmission(taskId), provider);
}

/** New paid calls use one transaction for task creation, budget reservation, and dispatch intent. */
export async function dispatchNewTask(
  store: ProductionStore,
  input: TaskInput,
  provider: ProviderSubmissionPort,
): Promise<DispatchOutcome> {
  if (input.provider !== provider.providerId) throw new Error("Task provider does not match the selected adapter.");
  return submitStarted(store, store.createTaskAndBeginSubmission(input), provider);
}

async function submitStarted(store: ProductionStore, started: DispatchResult,
  provider: ProviderSubmissionPort): Promise<DispatchOutcome> {
  if (started.status !== "started" && started.status !== "warning_90") {
    return { status: started.status, task: started.task };
  }

  try {
    const accepted = await provider.submit(started.task);
    if (!accepted.providerTaskId.trim()) throw new Error("Provider returned an empty task ID.");
    return { status: "accepted", task: store.registerProviderTask(started.task.id, accepted.providerTaskId) };
  } catch (error) {
    return { status: "reconcile_required", task: store.markReconciliationRequired(started.task.id), error };
  }
}

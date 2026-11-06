import { ProductionStore, type ChargeDetails } from "./store";

export type ProviderPollResult =
  | { state: "running" }
  | { state: "failed"; chargeStatus: "no_charge" | "charged" | "unknown";
      sourceRef?: string; amountMicros?: number; currency?: string; chargeDetails?: ChargeDetails }
  | { state: "succeeded"; remoteUrl: string; destinationPath: string; expiresAt: number;
      chargeStatus: "unknown" }
  | { state: "succeeded"; remoteUrl: string; destinationPath: string; expiresAt: number;
      chargeStatus: "charged"; sourceRef: string; amountMicros: number; currency: string; chargeDetails?: ChargeDetails };

export interface ProviderPollingPort {
  readonly providerId: string;
  poll(providerTaskId: string, task?: import("./store").Task): Promise<ProviderPollResult>;
}

export async function reconcileProviderTask(store: ProductionStore, taskId: string, provider: ProviderPollingPort) {
  const task = store.getTask(taskId);
  if (task.provider !== provider.providerId) throw new Error("Task provider does not match the selected adapter.");
  // Finished artifacts need no provider poll; cost settlement remains an independent ledger operation.
  if (task.state === "succeeded") return { status: "already_succeeded" as const, task };
  if (!task.providerTaskId) return { status: "reconcile_required" as const, task: store.markReconciliationRequired(taskId) };
  let result: ProviderPollResult;
  try { result = await provider.poll(task.providerTaskId, task); }
  catch (error) {
    return { status: "reconciling" as const, task: store.markReconciliationRequired(taskId), error };
  }

  if (result.state === "running") return { status: "running" as const, task };
  if (result.state === "failed") {
    if (result.chargeStatus === "charged") {
      if (!result.sourceRef || result.amountMicros === undefined || !result.currency) {
        return { status: "reconciling" as const, task: store.markReconciliationRequired(taskId) };
      }
      store.settleReservation(taskId, result.sourceRef, result.amountMicros, result.currency, result.chargeDetails);
    }
    const failed = store.failTask(taskId, result.chargeStatus === "no_charge");
    return { status: "failed" as const, task: failed, chargeStatus: result.chargeStatus };
  }

  if (task.billable && result.chargeStatus === "charged"
    && (!result.sourceRef || !result.currency || !Number.isSafeInteger(result.amountMicros))) {
    return { status: "reconciling" as const, task: store.markReconciliationRequired(taskId) };
  }
  try {
    if (task.billable && result.chargeStatus === "charged") {
      store.settleReservation(taskId, result.sourceRef, result.amountMicros, result.currency, result.chargeDetails);
    }
    store.enqueueMediaDownload(taskId, "primary", result.remoteUrl, result.destinationPath, result.expiresAt);
    return { status: task.billable && result.chargeStatus === "unknown"
      ? "awaiting_download_charge_reconciliation" as const
      : "awaiting_download" as const, task: store.getTask(taskId) };
  } catch (error) {
    return { status: "reconciling" as const, task: store.markReconciliationRequired(taskId), error };
  }
}

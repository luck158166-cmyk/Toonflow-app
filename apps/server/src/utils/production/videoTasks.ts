import { launchProductionMediaTask, recoverProductionMediaTask, syncProductionMediaTask } from "./mediaTasks";

export function launchProductionVideoTask(directory: string, projectId: string, taskId: string) {
  return launchProductionMediaTask(directory, projectId, taskId, "video");
}
export function recoverProductionVideoTask(directory: string, projectId: string, taskId: string) {
  return recoverProductionMediaTask(directory, projectId, taskId, "video");
}
export function syncProductionVideoTask(directory: string, projectId: string, taskId: string) {
  return syncProductionMediaTask(directory, projectId, taskId, "video");
}

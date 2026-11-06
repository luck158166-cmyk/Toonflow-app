import { ProductionStore, type PendingMediaDownload } from "./store";

/** Implementations should write atomically to destinationPath and treat repeats as safe. */
export interface MediaDownloadPort {
  download(remoteUrl: string, destinationPath: string): Promise<{ sha256: string }>;
}

export async function processPendingMediaDownloads(
  store: ProductionStore,
  downloader: MediaDownloadPort,
  clock: () => number = Date.now,
  limit = 10,
) {
  const claimed: PendingMediaDownload[] = store.claimDueMediaDownloads(clock(), limit);
  let downloaded = 0;
  let retrying = 0;
  let expired = 0;
  for (const item of claimed) {
    try {
      const result = await downloader.download(item.remoteUrl, item.destinationPath);
      store.completeMediaDownload(item.id, result.sha256, clock());
      downloaded += 1;
    } catch {
      const outcome = store.failMediaDownload(item.id, "download_failed", clock());
      if (outcome === "expired") expired += 1;
      else retrying += 1;
    }
  }
  return { claimed: claimed.length, downloaded, retrying, expired };
}

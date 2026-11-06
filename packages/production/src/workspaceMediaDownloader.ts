import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { lstat, realpath, mkdir, open, link, unlink, readFile, createReadStream, writeAtomic } from "@toonflow/file";
import type { MediaDownloadPort } from "./mediaDownloadWorker";

type FetchMedia = (url: string, options: RequestInit) => Promise<Response>;
type Receipt = { version: 1; sourceHash: string; sha256: string; bytes: number };

async function inspect(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Single-process workspace downloader. The host must exclude concurrent external filesystem mutation. */
export class WorkspaceMediaDownloader implements MediaDownloadPort {
  private readonly fetchMedia: FetchMedia;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(private readonly directory: string, options: {
    fetchMedia?: FetchMedia; maxBytes?: number; timeoutMs?: number;
  } = {}) {
    this.fetchMedia = options.fetchMedia ?? fetch;
    this.maxBytes = options.maxBytes ?? 2 * 1024 ** 3;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0
      || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new TypeError("Invalid download limits.");
  }

  private async destination(path: string) {
    const parts = path.replaceAll("\\", "/").split("/");
    if (!parts.length || parts.some(part => !part || part === "." || part === ".."
      || /[\x00-\x1f:<>"|?*]|[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new TypeError("Download destination must be a Windows-safe workspace relative path.");
    }
    const root = await realpath(resolve(this.directory));
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      let entry = await inspect(parent);
      if (!entry) {
        try { await mkdir(parent); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        entry = await lstat(parent);
      }
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Download parent must be an ordinary directory.");
    }
    return join(parent, parts.at(-1)!);
  }

  async download(remoteUrl: string, destinationPath: string): Promise<{ sha256: string }> {
    const url = new URL(remoteUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new TypeError("Media URL must use HTTPS without user credentials.");
    const target = await this.destination(destinationPath);
    const receiptPath = `${target}.download.json`;
    const sourceHash = createHash("sha256").update(remoteUrl).digest("hex");
    const receiptStat = await inspect(receiptPath);
    if (receiptStat && (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.size > 4096)) {
      throw new Error("Invalid download receipt file.");
    }
    let receipt: Receipt | undefined;
    if (receiptStat) {
      receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      if (receipt?.version !== 1 || receipt.sourceHash !== sourceHash || !/^[a-f0-9]{64}$/.test(receipt.sha256)
        || !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0 || receipt.bytes > this.maxBytes) {
        throw new Error("Download receipt does not match the requested artifact.");
      }
    }
    const existing = await inspect(target);
    if (existing) {
      if (!receipt || existing.isSymbolicLink() || !existing.isFile() || existing.size !== receipt.bytes
        || await hashFile(target) !== receipt.sha256) throw new Error("Existing destination cannot be replaced or adopted.");
      return { sha256: receipt.sha256 };
    }

    const temporary = join(dirname(target), `.download-${randomUUID()}.part`);
    const signal = AbortSignal.timeout(this.timeoutMs);
    let created = false;
    try {
      const response = await this.fetchMedia(remoteUrl, { signal, redirect: "error" });
      if (!response.ok || response.status === 206 || !response.body) throw new Error(`Media download failed (HTTP ${response.status}).`);
      const declaredSize = Number(response.headers.get("content-length"));
      if (declaredSize > this.maxBytes) { await response.body.cancel(); throw new Error("Media download exceeds the byte limit."); }
      const handle = await open(temporary, "wx", 0o600);
      created = true;
      const hash = createHash("sha256");
      let bytes = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > this.maxBytes) throw new Error("Media download exceeds the byte limit.");
          hash.update(chunk.value);
          await handle.writeFile(chunk.value);
        }
        if (!bytes) throw new Error("Media response is empty.");
        if (declaredSize > 0 && !response.headers.get("content-encoding") && bytes !== declaredSize) {
          throw new Error("Media response ended before the declared content length was received.");
        }
        await handle.sync();
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        await handle.close();
      }
      const result: Receipt = { version: 1, sourceHash, sha256: hash.digest("hex"), bytes };
      if (receipt && (receipt.sha256 !== result.sha256 || receipt.bytes !== result.bytes)) {
        throw new Error("Provider returned different bytes for the same artifact.");
      }
      if (!receipt) await writeAtomic(receiptPath, JSON.stringify(result), { exclusive: true });
      // Hard-link publication is atomic and fails if the destination already exists.
      // A crash after publication is recovered using the durable receipt and content hash.
      await link(temporary, target);
      return { sha256: result.sha256 };
    } finally {
      if (created) await unlink(temporary);
    }
  }
}

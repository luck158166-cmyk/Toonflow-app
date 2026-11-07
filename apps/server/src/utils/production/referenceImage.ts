import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "@toonflow/file";
import { resolveWorkspacePath, lockWorkspaceFiles } from "@/utils/workspace/files";
import { detectMimeType } from "@/utils/media/priceReference";

const maxReferenceBytes = 20 * 1024 * 1024;
async function readImageBytes(directory: string, path: string, expectedSha256: string) {
  const resolved = await resolveWorkspacePath(directory, path);
  const info = await lstat(resolved.path);
  if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > maxReferenceBytes) throw new Error("参考图须为不超过 20 MB 的普通文件");
  const bytes = await readFile(resolved.path);
  if (!bytes.length || bytes.length > maxReferenceBytes || createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new Error("图片内容已变化，请重新选择并预览");
  }
  return bytes;
}

export async function preserveReferenceImage(directory: string, path: string, expectedSha256: string) {
  const source = await resolveWorkspacePath(directory, path);
  const release = lockWorkspaceFiles([source.path]);
  let bytes: Buffer;
  try { bytes = await readImageBytes(directory, path, expectedSha256); }
  finally { release(); }
  const mimeType = detectMimeType(bytes, "");
  const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>)[mimeType];
  if (!extension) throw new Error("参考图仅支持 PNG、JPEG、WebP 原图");
  const metadata = await new Bun.Image(bytes).metadata();
  const { width, height } = metadata;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 8192 || height > 8192 || width * height > 40_000_000) throw new Error("参考图尺寸无效或超过 8192 边长 / 4000 万像素");
  for (const folder of ["assets", "assets/productionReferences"]) {
    const target = await resolveWorkspacePath(directory, folder);
    try { await mkdir(target.path); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
    const info = await lstat(target.path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("参考图库路径必须是普通目录");
  }
  const relativePath = `assets/productionReferences/${expectedSha256}.${extension}`;
  const target = await resolveWorkspacePath(directory, relativePath);
  const releaseTarget = lockWorkspaceFiles([target.path]);
  try {
    try { await writeFile(target.path, bytes, { flag: "wx", mode: 0o600 }); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      await readImageBytes(directory, relativePath, expectedSha256);
    }
  } finally { releaseTarget(); }
  return { path: relativePath, sha256: expectedSha256, mimeType, width, height };
}

export async function readPreservedReference(directory: string, reference: { path: string; sha256: string }) {
  // Immutable originals can be read concurrently. Verify the actual bytes before returning;
  // exclusive write locks would incorrectly reject simultaneous thumbnails of the same file.
  return readImageBytes(directory, reference.path, reference.sha256);
}

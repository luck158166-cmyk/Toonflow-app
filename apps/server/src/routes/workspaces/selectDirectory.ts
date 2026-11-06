import { Router } from "express";
import { realpath } from "@toonflow/file";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { getRuntimePlatform } from "@/lib/platform";

const router = Router();
export default router.post("/", async (req, res) => {
  const native = getRuntimePlatform().nativeDevelopment && u.workspace.isLocalHostRequest(req);
  res.set("Cache-Control", "no-store");
  if (!native) return res.json(success({ native: false, manual: false, directory: null }));

  if (!u.workspace.isLocalWorkspaceRequest(req)) {
    return res.status(403).json(error("仅允许本机开发页面选择目录", null, 403));
  }

  // Windows browser development runs without a desktop window owner. A PowerShell
  // FolderBrowserDialog can wait invisibly in that process; use the in-page picker.
  if (process.platform === "win32") return res.json(success({ native: false, manual: true, directory: null }));
  const macScript = `try
  return POSIX path of (choose folder with prompt "选择工作目录")
on error number -128
  return ""
end try`;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("/usr/bin/osascript", ["-e", macScript]);
    const selected = stdout.replace(/\r?\n$/, "");
    const directory = selected ? await realpath(selected) : null;
    res.json(success({ native: true, manual: false, directory }));
  } catch {
    res.status(500).json(error("无法打开本机文件夹选择器，请重试", null, 500));
  }
});

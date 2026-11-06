import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { getToolStatus, target } from "@toonflow/ffmpeg";
import manifest from "../../package.json";

const root = resolve(import.meta.dirname, "../..");
const directory = resolve(process.env.TOONFLOW_DATA_DIR || resolve(root, "data"));
const toolDirectory = resolve(directory, "ffmpeg", target);
const git = Bun.which("git");
const gitVersion = git ? Bun.spawnSync([git, "--version"]).stdout.toString().trim() : "未找到 Git";
const tools = await getToolStatus(toolDirectory, "auto");
const drive = /^[a-z]:/i.test(directory) ? directory.slice(0, 1) : null;
const disk = drive && process.platform === "win32" ? Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `(Get-PSDrive -Name '${drive}').Free`], { timeout: 10000 }) : null;
const freeBytes = disk?.exitCode === 0 ? Number(disk.stdout.toString().trim()) : null;
const database = new Database(":memory:");
let sqliteVersion: unknown;
try { sqliteVersion = database.query("SELECT sqlite_version() AS version").get(); }
finally { database.close(); }
console.log(JSON.stringify({ platform: process.platform, arch: process.arch, bun: Bun.version, requiredBun: manifest.packageManager,
  bunMatches: manifest.packageManager === `bun@${Bun.version}`, git: gitVersion, directory, freeBytes, tools, sqlite: sqliteVersion,
  ffmpegHelp: Object.values(tools).every(tool => tool.path && !tool.error) ? null : "可在 Toonflow 插件市场按现有流程下载 FFmpeg；此检查不自动下载。",
}, null, 2));
if (manifest.packageManager !== `bun@${Bun.version}` || !git || process.platform !== "win32") process.exitCode = 1;

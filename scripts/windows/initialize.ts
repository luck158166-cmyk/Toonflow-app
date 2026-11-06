import { resolve } from "node:path";
import manifest from "../../package.json";

if (process.platform !== "win32") throw new Error("此初始化脚本用于 Windows。");
if (manifest.packageManager !== `bun@${Bun.version}`) throw new Error(`请使用 ${manifest.packageManager}，当前为 bun@${Bun.version}`);
const root = resolve(import.meta.dirname, "../..");
// ACT: ARM64 Windows 可能同时使用 x64 Bun 与 ARM64 Node；安装两种 CPU 的可选依赖，避免构建工具找不到原生模块。
const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile", "--cpu", "*"], { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
if (await install.exited !== 0) throw new Error("依赖安装失败，未初始化数据目录。");
const { mkdir, realpath } = await import("@toonflow/file");
const directory = resolve(process.env.TOONFLOW_DATA_DIR || resolve(root, "data"));
await mkdir(directory, { recursive: true });
await mkdir(resolve(directory, "logs"), { recursive: true });
console.log(`依赖已就绪，数据目录：${await realpath(directory)}\n生产库由生产模块迁移创建；此步骤不会覆盖设置或发起模型请求。`);

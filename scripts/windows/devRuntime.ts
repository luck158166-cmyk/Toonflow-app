import { createHash } from "node:crypto";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { appendFile, mkdir, readFile, realpath, writeFile } from "@toonflow/file";

const root = resolve(import.meta.dirname, "../..");
const action = process.argv[2];
if (process.platform !== "win32") throw new Error("此脚本用于 Windows 本地开发。");
if (!["start", "stop", "status"].includes(action ?? "") || process.argv.length !== 3) {
  throw new Error("用法：bun scripts/windows/devRuntime.ts <start|stop|status>");
}
const requestedDirectory = resolve(process.env.TOONFLOW_DATA_DIR || resolve(root, "data"));
if (action === "start") await mkdir(requestedDirectory, { recursive: true });
const directory = await realpath(requestedDirectory).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT" && action !== "start") return requestedDirectory;
  throw error;
});
const key = createHash("sha256").update(directory.toLowerCase()).digest("hex").slice(0, 24);
const pipeName = `\\\\.\\pipe\\toonflowDev${key}`;

if (action !== "start") {
  await new Promise<void>((resolveRequest, reject) => {
    const socket = createConnection(pipeName);
    let response = "";
    socket.setTimeout(15000, () => socket.destroy(new Error("开发服务控制请求超时")));
    socket.on("connect", () => socket.write(`${action}\n`));
    socket.on("data", chunk => { response += chunk.toString(); });
    socket.on("end", () => { console.log(response.trim()); resolveRequest(); });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        console.log("此数据目录的开发服务未运行。");
        resolveRequest();
      } else reject(error);
    });
  });
} else {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  if (manifest.packageManager !== `bun@${Bun.version}`) throw new Error(`请使用 ${manifest.packageManager}，当前为 bun@${Bun.version}`);
  const serverPort = Number(process.env.TOONFLOW_SERVER_PORT || 3000);
  const webPort = Number(process.env.TOONFLOW_WEB_PORT || 5173);
  if ([serverPort, webPort].some(port => !Number.isInteger(port) || port < 1 || port > 65535) || serverPort === webPort) {
    throw new Error("前后端端口必须不同，且为 1–65535 的整数。");
  }
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const pumps: Promise<void>[] = [];
  const clients = new Set<Socket>();
  let stopping = false;
  let resolveStop: () => void;
  const stopped = new Promise<void>(resolvePromise => { resolveStop = resolvePromise; });
  const control = createServer(socket => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(1000, () => socket.destroy());
    let command = "";
    socket.on("data", chunk => {
      command += chunk.toString();
      if (command.length > 32) { socket.destroy(); return; }
      if (!command.endsWith("\n")) return;
      if (command === "status\n") {
        socket.end(JSON.stringify({ state: stopping ? "stopping" : "running", directory, serverPort, webPort }) + "\n");
      } else if (command === "stop\n") {
        socket.setTimeout(0);
        void stop().then(() => socket.end("开发服务已停止。\n"));
      } else socket.destroy();
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    control.once("error", reject);
    control.listen(pipeName, () => { control.off("error", reject); resolveListen(); });
  }).catch(error => { throw new Error("此数据目录已有开发服务，或无法创建本地控制管道。", { cause: error }); });

  async function stop() {
    if (stopping) return stopped;
    stopping = true;
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(child => child.exited));
    await Promise.allSettled(pumps);
    resolveStop();
  }
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  try {
    const logs = resolve(directory, "logs");
    await mkdir(logs, { recursive: true });
    const log = resolve(logs, `dev${Date.now()}.log`);
    await writeFile(log, `启动时间：${new Date().toISOString()}\n数据目录：${directory}\n`, { flag: "wx" });
    const env = { ...process.env, NODE_ENV: "dev", TOONFLOW_DATA_DIR: directory, TOONFLOW_SERVER_PORT: String(serverPort) };
    const webDirectory = resolve(root, "apps/web");
    const viteManifest = Bun.resolveSync("vite/package.json", webDirectory);
    const viteEntry = resolve(dirname(viteManifest), "bin/vite.js");
    async function pump(stream: ReadableStream<Uint8Array>, output: NodeJS.WriteStream) {
      for await (const chunk of stream) {
        output.write(chunk);
        await appendFile(log, chunk);
      }
    }
    for (const [entry, cwd, args] of [
      [resolve(root, "apps/server/src/index.ts"), root, []],
      [viteEntry, webDirectory, ["--host", "127.0.0.1", "--port", String(webPort), "--strictPort"]],
    ] as const) {
      const child = Bun.spawn([process.execPath, entry, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      children.push(child);
      pumps.push(pump(child.stdout, process.stdout), pump(child.stderr, process.stderr));
    }
    console.log(`页面：http://127.0.0.1:${webPort}\n日志：${log}\n停止：Ctrl+C，或在另一终端运行相同脚本的 stop 命令。`);
    // ACT: 单个开发会话、两个直接子进程；不使用 shell/后台守护进程，停止不会按端口误杀其他程序。
    await Promise.race([stopped, ...children.map(async child => {
      const code = await child.exited;
      if (!stopping) { process.exitCode = code || 1; await stop(); }
    }), ...pumps.map(async pumpPromise => {
      try { await pumpPromise; await stopped; }
      catch (error) { console.error(error); process.exitCode = 1; await stop(); }
    })]);
  } finally {
    await stop();
    // stop 的响应先送出；其余未完成命令不阻止关闭控制管道。
    for (const socket of clients) if (!socket.writableEnded) socket.end("开发服务已停止。\n");
    control.close();
  }
}

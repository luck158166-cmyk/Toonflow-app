import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

it("uses real host HTTP, checkpoints and downloads across cold restarts, never resubmits success or unknown tasks, and preserves the production gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "arkHost"));
  async function run(phase: string, directory = root) {
    const child = Bun.spawn([process.execPath, resolve("qa/volcengineHostScenario.ts"), directory, phase], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`${phase}: ${code}\n${stdout}\n${stderr}`);
    return JSON.parse(readFileSync(join(directory, `result${phase}.json`), "utf8"));
  }
  const submitted = await run("submit");
  expect(submitted.submissionStatus).toBe(200);
  expect(submitted.duplicateStatus).toBe(200);
  expect(submitted.snapshot).toMatchObject({ state: "interrupted", resumable: true, providerData: { taskId: "arkHostQa" } });
  expect(submitted.calls.filter((call: string) => call.startsWith("POST"))).toHaveLength(1);
  expect(submitted.models.find((model: { providerId: string }) => model.providerId === "volcengine")).toMatchObject({
    type: "video", supportsPrice: false, imageRatios: ["9:16", "16:9", "4:3", "1:1", "3:4", "21:9", "adaptive"],
  });
  const taskDirectory = join(root, "data/mediaTasks", readdirSync(join(root, "data/mediaTasks"))[0]!);
  const readTask = (suffix: string) => JSON.parse(readFileSync(join(taskDirectory, `task1111111111114111811111111111111${suffix}.json`), "utf8"));
  expect(readTask("1").checkpoint.providerData.taskId).toBe("arkHostQa");
  expect(JSON.stringify(readTask("1"))).not.toContain("qaHostKeyNeverSend");
  const resumed = await run("resume");
  expect(resumed.snapshot.state).toBe("succeeded");
  expect(resumed.calls.filter((call: string) => call.startsWith("POST"))).toHaveLength(0);
  expect(resumed.calls.filter((call: string) => call.includes("qa.mp4"))).toHaveLength(1);
  const output = readTask("1").checkpoint.files[0];
  const bytes = readFileSync(join(root, "workspace", output.path));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(output.hash);
  expect(readTask("1").checkpoint.providerData.usage.total_tokens).toBe(17);
  const repeated = await run("repeat");
  expect(repeated.snapshot.state).toBe("succeeded");
  expect(repeated.calls).toEqual([]);
  expect(repeated.snapshot.result.data).toEqual(resumed.snapshot.result.data);
  const unknown = await run("unknown");
  expect(unknown.snapshot).toMatchObject({ state: "interrupted", resumable: false });
  expect(unknown.calls.filter((call: string) => call.startsWith("POST"))).toHaveLength(1);
  const unknownResume = await run("unknownResume");
  expect(unknownResume.snapshot).toMatchObject({ state: "interrupted", resumable: false });
  expect(unknownResume.calls).toEqual([]);
  const gated = await run("gate");
  expect(gated.submissionStatus).toBe(409);
  expect(gated.failure).toContain("预算");
  expect(gated.calls).toEqual([]);
  const crashRoot = mkdtempSync(join(tmpdir(), "arkHostCrash"));
  const crash = await run("crash", crashRoot);
  expect(crash.calls.filter((call: string) => call.startsWith("POST"))).toHaveLength(1);
  const crashTaskDirectory = join(crashRoot, "data/mediaTasks", readdirSync(join(crashRoot, "data/mediaTasks"))[0]!);
  const crashedTask = JSON.parse(readFileSync(join(crashTaskDirectory, "task11111111111141118111111111111111.json"), "utf8"));
  expect(crashedTask).toMatchObject({ state: "running", checkpoint: { providerData: { taskId: "arkHostQa" } } });
  const recoveredCrash = await run("resume", crashRoot);
  expect(recoveredCrash.snapshot.state).toBe("succeeded");
  expect(recoveredCrash.calls.filter((call: string) => call.startsWith("POST"))).toHaveLength(0);
  console.log("隔离验证目录：" + root);
}, 120000);

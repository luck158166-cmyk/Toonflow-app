import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "@toonflow/file";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
async function run(root: string, phase: string) {
  const child = Bun.spawn([process.execPath, resolve("qa/imageRecoveryScenario.ts"), root, phase], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`${phase}: ${stdout}\n${stderr}`);
  return JSON.parse(readFileSync(join(root, `result${phase}.json`), "utf8"));
}
it("downloads the same original after a process exit and reuses its adopted version without another paid POST", async () => {
  const root = mkdtempSync(join(tmpdir(), "imageRecovery")); const first = await run(root, "downloadExit");
  expect(first.record.checkpoint.providerData.kind).toBe("arkImage"); expect(first.calls.filter((call: string) => call.startsWith("POST"))).toHaveLength(1);
  const resumed = await run(root, "resume"); expect(resumed.task.id).toBe(first.task.id); expect(resumed.task.state).toBe("succeeded");
  expect(resumed.calls).toEqual(["GET https://media.example.test/recovery.png"]);
  expect(resumed.adopted.reference.origin.taskId).toBe(first.task.id); expect(resumed.usage.reservedMicros).toBe(100); expect(resumed.usage.chargedMicros).toBe(0);
  const repeated = await run(root, "repeat"); expect(repeated.calls).toEqual([]); expect(repeated.adopted.created).toBe(false);
  expect(repeated.adopted.reference.id).toBe(resumed.adopted.reference.id);
  console.log("图片冷恢复验证目录：" + root);
}, 120000);
it("does not regenerate an unknown submission or an expired download URL, and keeps the reservation for reconciliation", async () => {
  const unknownRoot = mkdtempSync(join(tmpdir(), "imageUnknown")); const first = await run(unknownRoot, "unknown");
  expect(first.record.checkpoint.providerData).toBeUndefined(); const unknown = await run(unknownRoot, "resume");
  expect(unknown.calls).toEqual([]); expect(unknown.task.state).toBe("reconcile_required"); expect(unknown.usage.reservedMicros).toBe(100);
  const expiredRoot = mkdtempSync(join(tmpdir(), "imageExpired")); await run(expiredRoot, "downloadExit");
  const expired = await run(expiredRoot, "expired"); expect(expired.task.state).toBe("reconcile_required");
  expect(expired.calls.length).toBeGreaterThan(0); expect(expired.calls.every((call: string) => call === "GET https://media.example.test/recovery.png")).toBe(true);
  expect(expired.usage.reservedMicros).toBe(100); expect(expired.usage.chargedMicros).toBe(0); expect(expired.adopted).toBeUndefined();
}, 120000);

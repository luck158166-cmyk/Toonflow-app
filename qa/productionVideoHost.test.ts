import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "@toonflow/file";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

async function run(root: string, phase: string) {
  const child = Bun.spawn([process.execPath, resolve("qa/productionVideoHostScenario.ts"), root, phase], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`${phase}: ${code}\n${stdout}\n${stderr}`);
  return JSON.parse(readFileSync(join(root, `result${phase}.json`), "utf8"));
}

it("production bridge preserves one reservation/UUID through duplicate launch, cold receipt recovery and verified native output", async () => {
  const root = mkdtempSync(join(tmpdir(), "productionHost"));
  const first = await run(root, "submit");
  expect(first.calls.filter((call: string) => call.startsWith("POST"))).toHaveLength(1);
  expect(first.task.state).toBe("reconciling"); expect(first.task.providerTaskId).toBe("productionHostQa");
  expect(first.usage.reservedMicros).toBe(100); expect(first.bypassError).toContain("预算");
  expect(first.wrongScopeStatus).not.toBe(200);
  const recovered = await run(root, "resume");
  expect(recovered.recoveryStatus).toBe(200); expect(recovered.task.state).toBe("succeeded");
  expect(recovered.calls.filter((call: string) => call.startsWith("POST"))).toHaveLength(0);
  expect(recovered.listed[0]).toMatchObject({ hostTaskId: first.task.id, segmentKey: "QA 方案 1 / 片段 1", outputCount: 1 });
  expect(recovered.usage.reservedMicros).toBe(100); expect(recovered.usage.chargedMicros).toBe(0);
  const repeat = await run(root, "repeat"); expect(repeat.calls).toEqual([]); expect(repeat.task.id).toBe(first.task.id);
  const tampered = await run(root, "tamper"); expect(tampered.recoveryStatus).not.toBe(200);
  expect(tampered.result.message).toContain("哈希"); expect(tampered.calls).toEqual([]);
  expect(tampered.task.state).toBe("succeeded"); expect(tampered.usage.reservedMicros).toBe(100);
  console.log("生产宿主验证目录：" + root);
}, 120000);

it("recovers a process exit after the native receipt, but never re-POSTs unknown or missing host submissions", async () => {
  const crash = mkdtempSync(join(tmpdir(), "productionCrash")); await run(crash, "crash");
  const restored = await run(crash, "resume"); expect(restored.task.state).toBe("succeeded");
  expect(restored.calls.filter((call: string) => call.startsWith("POST"))).toHaveLength(0);
  for (const phase of ["unknown", "missing"]) {
    const root = mkdtempSync(join(tmpdir(), "productionUnknown")); const first = await run(root, phase);
    expect(first.task.state).toBe("reconcile_required"); expect(first.usage.reservedMicros).toBe(100);
    const resumed = await run(root, "resume"); expect(resumed.task.state).toBe("reconcile_required");
    expect(resumed.calls).toEqual([]); expect(resumed.usage.reservedMicros).toBe(100);
  }
}, 120000);

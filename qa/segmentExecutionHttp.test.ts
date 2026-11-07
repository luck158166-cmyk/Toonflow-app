import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "@toonflow/file";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

it("saves/reviews/previews a real segment over HTTP, refuses stale price and changed bytes, then submits only one native task", async () => {
  const root = mkdtempSync(join(tmpdir(), "segmentExecution"));
  const child = Bun.spawn([process.execPath, resolve("qa/segmentExecutionScenario.ts"), root], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(stdout + stderr);
  const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
  expect(result.saved.status).toBe(200); expect(result.unreviewed.body.data.canSubmit).toBe(false);
  expect(result.reviewed.status).toBe(200); expect(result.first.body.data.canSubmit).toBe(true);
  expect(result.stale.status).toBe(409); expect(result.tampered.status).toBe(409); expect(result.callsBeforeStart).toEqual([]);
  expect(result.atReadError).toContain("授权内容不符"); expect(result.revisionError).toContain("供应商代码已变化");
  expect(result.budget.body.data.state).toBe("queued");
  expect(result.results.map((item: any) => item.status)).toEqual([200, 200]);
  expect(result.tasks).toHaveLength(1); expect(result.task.state).toBe("succeeded"); expect(result.tasks[0].outputCount).toBe(1);
  expect(result.repeat.body.data.taskId).toBe(result.task.id);
  expect(result.calls.filter((call: string) => call.startsWith("POST"))).toHaveLength(1);
  expect(result.usage.reservedMicros).toBe(1100); expect(result.usage.chargedMicros).toBe(0);
  expect(result.backup.binding).toEqual([{ taskId: result.task.id }]); expect(result.backup.reviews).toHaveLength(1);
  expect(result.backup.native.record.checkpoint.providerData.taskId).toBe("segmentExecutionQa");
  expect(result.backup.native.record.state).toBe("succeeded");
  expect(JSON.stringify(result)).not.toContain("qaNeverRealKey"); console.log("片段 HTTP 验证目录：" + root);
}, 120000);

import type { ShotReferenceSlot } from "./shotPreparation";

export type PortraitEligibility = { referenceId: string | null; name: string; role: "headshot" | "fullBody";
  eligible: boolean; status: "eligible" | "expiring" | "expired" | "missingSource" | "invalidSource" | "credentialMismatch" | "futureSource";
  expiresAt: number | null; message: string };
export const portraitPolicyVersion = "arkOriginalPortrait.v1";
const dayMs = 24 * 60 * 60_000;

/** Local evidence for documented input conditions; never a claim of platform approval or visual identity. */
export function inspectPortraitEligibility(references: ShotReferenceSlot[], credentialScope?: string, now = Date.now()): PortraitEligibility[] {
  return references.filter(slot => slot.role === "headshot" || slot.role === "fullBody").map(slot => {
    const reference = slot.reference; const origin = reference?.origin;
    const base = { referenceId: reference?.id ?? null, name: slot.name, role: slot.role as "headshot" | "fullBody" };
    const fail = (status: PortraitEligibility["status"], message: string, expiresAt: number | null = null): PortraitEligibility =>
      ({ ...base, eligible: false, status, message, expiresAt });
    if (!reference || !origin) return fail("missingSource", "缺少本软件保存的模型原图来源；本地上传与人工确认不能代替生成凭据");
    if (origin.modelId !== "doubao-seedream-5-0-pro-260628" || origin.method !== "textToImage" || !origin.taskId
      || !/^[a-f0-9]{64}$/.test(origin.credentialScope) || origin.originalSha256 !== reference.sha256
      || !Number.isSafeInteger(origin.generatedAt) || origin.generatedAt < Date.parse("2026-04-16T00:00:00+08:00")) {
      return fail("invalidSource", "原图来源、方式、时间或内容哈希不符合已接入的方舟文生图条件");
    }
    const expiresAt = origin.generatedAt + 30 * dayMs;
    if (origin.generatedAt > now) return fail("futureSource", "生成时间晚于本机时间，请先校准时钟并核对记录", expiresAt);
    if (now >= expiresAt) return fail("expired", "原图已超过 30 天使用期；保留原图与已生成视频，不自动重新收费生成", expiresAt);
    if (!credentialScope || credentialScope !== origin.credentialScope) return fail("credentialMismatch", "当前方舟凭据与生成原图时不同，不能确认同账号使用条件；同账号换密钥也须重新核对", expiresAt);
    const expiring = expiresAt - now <= 7 * dayMs;
    return { ...base, eligible: true, status: expiring ? "expiring" : "eligible", expiresAt,
      message: expiring ? "原图将在 7 天内到期，请安排后续制作；不会自动刷新原图" : "文生图来源、同凭据和期限满足本地使用条件，最终仍由平台审核" };
  });
}

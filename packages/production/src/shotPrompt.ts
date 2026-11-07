import { createHash, randomUUID } from "node:crypto";
import type { ProductionCatalog } from "./catalog";
import { getShotPreparation, type ShotReferenceSlot } from "./shotPreparation";
import { cameraMoves, validateShotDirection } from "./shotDirection";

type PromptCheck = { code: string; state: "passed" | "failed" | "pending"; message: string };
const templateVersion = "seedance25Shot.v2";
const audioConstraint = "只保留角色人声、环境音和动作音效；不要音乐、背景音乐、BGM、配乐、器乐、旋律、合成器音效、氛围铺底音。不要字幕。";
const roleNames = { headshot: "面部参考", fullBody: "全身妆造参考", costume: "服装参考", scene: "场景参考", prop: "道具参考" };

export function renderVideoPrompt(references: ShotReferenceSlot[], characterCount: number, summary: string, frames: string[], environment: string, style: string) {
  const mappings = references.map(slot => `图片${slot.index}是${slot.name}的${roleNames[slot.role]}`).join("；");
  const castConstraint = characterCount ? `人物面部与参考图保持一致；画面只出现${characterCount}名已绑定角色，同一画面每个角色只出现一次，禁止同款分身、双胞胎；人物眼睛为正常人眼。` : "本片段为空镜，画面不出现人物。";
  return [`【素材】${mappings}。`, `【音频约束】${audioConstraint}`, `【概述】${summary}`, ...frames,
    `【全片】${environment}；${style}。`,
    `【约束】${castConstraint}不要字幕、不要水印、不要 Logo、不要文字。${audioConstraint}`].join("\n");
}

/** Reused by single-shot and segment compilers. No database writes or provider calls. */
export function compilePreparedShot(preparation: ReturnType<typeof getShotPreparation>, startSeconds = 0) {
  const { shot, references, characters, dialogue, props } = preparation.snapshot;
  const checks: PromptCheck[] = preparation.issues.map(issue => ({ code: issue.code, state: "failed", message: issue.message }));
  const check = (code: string, valid: boolean, message: string) => checks.push({ code, state: valid ? "passed" : "failed", message });
  const seconds = shot.durationMs / 1000;
  check("P04", Number.isInteger(seconds) && seconds >= 4 && seconds <= 30, "单镜需为 4–30 整数秒；更短或更长的镜头须先划分片段，不能静默取整");
  check("P12", characters.length <= 5 && references.filter(item => ["headshot", "fullBody"].includes(item.role)).length <= 8
    && references.length <= 30, "采用项目保守上限：人物 ≤5、人物参考图 ≤8；API 图片总数 ≤30");
  check("P13", references.every(item => item.reference && ["image/png", "image/jpeg", "image/webp"].includes(item.reference.mimeType)
    && item.reference.width * item.reference.height <= 1080 * 1920), "原图格式与像素总数不得超过本次 1080×1920 输出；原图字节还须由宿主核验");
  let direction = shot.direction;
  try { validateShotDirection(direction, characters.map(item => item.name)); }
  catch (cause) { checks.push({ code: "direction", state: "failed", message: cause instanceof Error ? cause.message : "缺少导演资料" }); direction = null; }
  const creativeText = direction ? [direction.summary, direction.action, direction.environment, direction.style, direction.sound,
    ...direction.positions.flatMap(item => [item.start, item.end])].join("\n") : "";
  check("P06", !!direction && !cameraMoves.some(move => creativeText.includes(move)), "主运镜只由独立字段提供，动作及环境段不能再叠加另一运镜");
  check("P07", !dialogue.some(line => line.text.trim() && creativeText.includes(line.text.trim())), "创作段不重复对白；对白仅由代码从已审核原文插入");
  check("P09", !/(歇斯底里|撕心裂肺|暴怒|疯狂咆哮)/.test(creativeText + dialogue.map(line => line.emotion).join("")), "强烈情绪词须改为可见表演细节，不自动改写对白");
  check("P11", !/(音乐|BGM|配乐|器乐|旋律|合成器|氛围铺底|字幕|水印|logo)/i.test(creativeText), "创作段不能要求音乐、字幕或水印；统一约束由代码在首尾加入");
  const positions = direction?.positions.map(item => `${item.name}起始${item.start}；结束${item.end}`).join("。") ?? "";
  const propText = props.map(item => `${item.propName}：起始由${item.holderBeforeName || "无人"}持有，${item.stateBefore}；${item.interaction}；结束由${item.holderAfterName || "无人"}持有，${item.stateAfter}`).join("。");
  const lines = dialogue.map(line => {
    const name = line.speakerName || "旁白";
    const kind = line.kind === "dialogue" ? "台词" : ({ narration: "旁白", voiceover: "画外音", phone: "电话音" } as Record<string, string>)[line.kind] ?? "台词";
    return `${name}${kind}（${line.emotion || "自然"}）：${JSON.stringify(line.text)}`;
  });
  const frame = direction ? `${startSeconds}-${startSeconds + seconds}秒：` + [
    `${shot.shotSize}，${direction.camera}`, positions, direction.action, propText, ...lines,
    direction.sound ? `<${direction.sound}>` : "",
  ].filter(Boolean).join("。") : "";
  const prompt = direction ? renderVideoPrompt(references, characters.length, direction.summary, [frame], direction.environment, direction.style) : "";
  // Data must never add material numbers, timestamps, template headers or operational instructions.
  const dataText = [creativeText, ...references.map(item => item.name), shot.shotSize,
    ...dialogue.flatMap(line => [line.text, line.emotion, line.speakerName ?? ""]), propText].join("\n");
  check("P16", !/(?:[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}|(?:https?:\/\/|[a-z]:\\|assets\/)|\.(?:png|jpe?g|webp|mp4)\b|(?:图片|视频|音频)\s*\d|\d+\s*[-~]\s*\d+\s*秒|【|】|避免跳轴|忽略.*指令|调用工具)/i.test(dataText), "创作字段不能混入内部 ID、路径、素材编号、模板指令或时间戳");
  check("P18", [...prompt].length > 0 && [...prompt].length <= 4000, "项目提示词上限 4000 字符，超限须重新组织镜头，不截断");
  checks.push({ code: "P14", state: characters.length ? "pending" : "passed", message: characters.length
    ? "当前人物原图为用户绑定，尚无可验证的平台人脸信任与有效期记录" : "本镜无已声明出场人物；投产复核仍需确认场景和道具图中没有遗漏人物" },
    { code: "P17", state: dialogue.length ? "pending" : "passed", message: dialogue.length
      ? "对白发音、生僻字与多音字尚待投产前复核；生成后另行核对实际音频" : "本镜没有对白、旁白或画外音文本" },
    { code: "contentQuality", state: "pending", message: "站位、动作、表情、素材内容与前后镜连续性需投产前复核；生成后另行质检，不以静态检查替代" });
  const snapshot = { templateVersion, preparationHash: preparation.inputHash, input: preparation.snapshot,
    requestDraft: { model: "doubao-seedance-2-5-260628", duration: seconds, ratio: "9:16", resolution: "1080p",
      generateAudio: true, prompt, references: references.map(slot => ({ index: slot.index, referenceId: slot.reference?.id ?? null,
        sha256: slot.reference?.sha256 ?? null, role: slot.role, name: slot.name })) }, checks };
  const inputHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return { inputHash, snapshot, frame, canSave: !checks.some(item => item.state === "failed"), readyForGeneration: false as const };
}

export function compileShotPrompt(catalog: ProductionCatalog, projectId: string, shotId: string) {
  const { frame, ...compiled } = compilePreparedShot(getShotPreparation(catalog, projectId, shotId));
  const history = catalog.db.query(`SELECT id, version, input_hash AS inputHash, created_at AS createdAt
    FROM compiled_shot_prompt WHERE project_id = ? AND shot_id = ? ORDER BY version DESC`).all(projectId, shotId) as
    Array<{ id: string; version: number; inputHash: string; createdAt: number }>;
  return { ...compiled, history };
}

/** Host checks original bytes before saving; compilation never edits a shot's runtime/readiness state. */
export function saveShotPrompt(catalog: ProductionCatalog, projectId: string, shotId: string, expectedHash: string) {
  return catalog.withTransaction(() => {
    const current = compileShotPrompt(catalog, projectId, shotId);
    if (current.inputHash !== expectedHash) throw new Error("镜头或提示词依据已变化，请重新编译");
    if (!current.canSave) throw new Error(current.snapshot.checks.find(item => item.state === "failed")!.message);
    const preparation = catalog.db.query("SELECT id FROM shot_preparation WHERE shot_id = ? AND input_hash = ?")
      .get(shotId, current.snapshot.preparationHash) as { id: string } | null;
    if (!preparation) throw new Error("请先保存当前镜头资料版本");
    const existing = current.history.find(item => item.inputHash === expectedHash);
    if (existing) return { ...existing, created: false };
    const id = randomUUID(); const version = (current.history[0]?.version ?? 0) + 1; const createdAt = Date.now();
    catalog.db.query(`INSERT INTO compiled_shot_prompt(id, project_id, shot_id, preparation_id, input_hash, version, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, projectId, shotId, preparation.id, expectedHash, version, JSON.stringify(current.snapshot), createdAt);
    return { id, version, inputHash: expectedHash, createdAt, created: true };
  });
}

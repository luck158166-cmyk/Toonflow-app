import { createHash } from "node:crypto";

export type SourceChapter = {
  sequence: number;
  title: string;
  lineStart: number;
  lineEnd: number;
  contentLineStart: number;
  characterCount: number;
};

export type ChapterIndex = {
  sourceHash: string;
  lineCount: number;
  chapterUnit: "章" | "回" | "节" | null;
  chapters: SourceChapter[];
  issues: string[];
};

export type SourceEvidence = { sourceHash: string; chapterSequence: number;
  lineStart: number; lineEnd: number; quote: string };

export type EvidenceCheck = { valid: true } | { valid: false; reason: string };

/** Exact source spans prevent a model from citing an unrelated chapter or invented quotation. */
export function checkSourceEvidence(sourceText: string, index: ChapterIndex, value: unknown): EvidenceCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, reason: "原文证据必须包含章节、行号、原文摘录和来源哈希。" };
  }
  const evidence = value as Partial<SourceEvidence>;
  if (evidence.sourceHash !== index.sourceHash) return { valid: false, reason: "来源哈希不匹配，原文可能已变更。" };
  const chapter = index.chapters.find(item => item.sequence === evidence.chapterSequence);
  if (!chapter || !Number.isSafeInteger(evidence.lineStart) || !Number.isSafeInteger(evidence.lineEnd)
    || evidence.lineStart! < chapter.contentLineStart || evidence.lineEnd! > chapter.lineEnd
    || evidence.lineStart! > evidence.lineEnd!) {
    return { valid: false, reason: "证据行号不在指定章节正文内。" };
  }
  if (typeof evidence.quote !== "string" || evidence.quote.trim().length < 2 || evidence.quote.length > 2000) {
    return { valid: false, reason: "原文摘录需为 2–2000 字。" };
  }
  const lines = sourceText.replace(/\r\n?/g, "\n").split("\n");
  const span = lines.slice(evidence.lineStart! - 1, evidence.lineEnd!).join("").replace(/\s/gu, "");
  const quote = evidence.quote.replace(/\s/gu, "");
  if (!span.includes(quote)) return { valid: false, reason: "原文摘录不在所引行号内。" };
  return { valid: true };
}

const chapterHeading = /^\s*第\s*([零〇一二三四五六七八九十百千万两\d]+)\s*(章|回|节)(?:[\s:：.．、·-]*.{0,40})?\s*$/u;

function chineseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const digit: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const unit: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  let section = 0;
  let total = 0;
  let current = 0;
  for (const char of value) {
    if (char in digit) { current = digit[char]; continue; }
    const multiplier = unit[char];
    if (!multiplier) return null;
    if (multiplier === 10000) { total += (section + current) * multiplier; section = 0; current = 0; }
    else { section += (current || 1) * multiplier; current = 0; }
  }
  return total + section + current;
}

/** A read-only index: line spans always refer to the immutable imported source text. */
export function indexNovel(sourceText: string): ChapterIndex {
  const sourceHash = createHash("sha256").update(sourceText).digest("hex");
  const lines = sourceText.replace(/\r\n?/g, "\n").split("\n");
  const headings = lines.flatMap((line, index) => {
    const match = line.length <= 64 ? chapterHeading.exec(line) : null;
    const number = match ? chineseNumber(match[1]) : null;
    return match && number !== null && Number.isSafeInteger(number)
      ? [{ line: index + 1, title: line.trim(), number, unit: match[2] as "章" | "回" | "节" }] : [];
  });
  const chapterUnit = (["章", "回", "节"] as const).find(unit => headings.filter(heading => heading.unit === unit).length >= 2)
    ?? headings[0]?.unit ?? null;
  const selected = headings.filter(heading => heading.unit === chapterUnit);
  const issues: string[] = [];
  if (!selected.length) issues.push("未识别到章节标题；请先确认分章边界。");
  const firstLine = lines.findIndex(line => line.trim()) + 1;
  if (selected.length && firstLine && selected[0].line > firstLine) {
    const prefix = lines.slice(firstLine - 1, selected[0].line - 1).join("").trim();
    if (prefix.length > 200) issues.push(`第一章前有 ${prefix.length} 字未归入章节，请确认序章或目录。`);
  }
  for (let index = 1; index < selected.length; index++) {
    const previous = selected[index - 1];
    const current = selected[index];
    if (current.number === previous.number) issues.push(`${current.title}：与上一章章号重复。`);
    else if (current.number !== previous.number + 1) issues.push(`${current.title}：章号不连续，请检查目录或缺章。`);
  }
  const chapters = selected.map((heading, index) => {
    const lineEnd = (selected[index + 1]?.line ?? lines.length + 1) - 1;
    const characterCount = lines.slice(heading.line, lineEnd).join("").replace(/\s/g, "").length;
    if (characterCount < 80) issues.push(`${heading.title}：正文不足 80 字，请检查目录残留或空章。`);
    return { sequence: index + 1, title: heading.title, lineStart: heading.line,
      lineEnd, contentLineStart: heading.line + 1, characterCount };
  });
  return { sourceHash, lineCount: lines.length, chapterUnit, chapters, issues };
}

export type ScriptCheck = { code: string; scene: number | null; message: string };
export type ScriptReport = { passed: boolean; estimatedSeconds: number; checks: ScriptCheck[] };

type ScriptBeat = { type?: unknown; text?: unknown; speaker?: unknown; evidence?: unknown };
type ScriptScene = { scene?: unknown; location?: unknown; characters?: unknown; beats?: unknown; evidence?: unknown };

/** Deterministic checks only. Dramatic quality and fidelity still need review against source. */
export function checkEpisodeScript(script: unknown[], chapters: SourceChapter[], targetSeconds?: number,
  requireEvidence = true): ScriptReport {
  const checks: ScriptCheck[] = [];
  let estimatedSeconds = 0;
  if (!script.length) checks.push({ code: "missingScript", scene: null, message: "尚无分场剧本。" });
  script.forEach((rawScene, index) => {
    const sceneNumber = index + 1;
    if (!rawScene || typeof rawScene !== "object" || Array.isArray(rawScene)) {
      checks.push({ code: "invalidScene", scene: sceneNumber, message: "场次必须是结构化对象。" });
      return;
    }
    const scene = rawScene as ScriptScene;
    const location = scene.location ?? scene.scene;
    if (typeof location !== "string" || !location.trim()) {
      checks.push({ code: "missingLocation", scene: sceneNumber, message: "场次缺少地点。" });
    }
    const characters = Array.isArray(scene.characters) ? scene.characters.filter((value): value is string => typeof value === "string") : [];
    const beats = Array.isArray(scene.beats) ? scene.beats as ScriptBeat[] : [];
    if (!beats.length) checks.push({ code: "missingBeats", scene: sceneNumber, message: "场次缺少动作与对白节拍。" });
    if (!beats.some(beat => beat && beat.type === "action")) {
      checks.push({ code: "missingAction", scene: sceneNumber, message: "每场至少需要一个可拍摄动作。" });
    }
    for (const [beatIndex, beat] of beats.entries()) {
      if (!beat || typeof beat !== "object" || typeof beat.text !== "string" || !beat.text.trim()) {
        checks.push({ code: "invalidBeat", scene: sceneNumber, message: `第 ${beatIndex + 1} 拍缺少文本。` });
        continue;
      }
      if (beat.type === "action") estimatedSeconds += 2.5;
      else if (beat.type === "dialogue" || beat.type === "voiceover") {
        estimatedSeconds += beat.text.replace(/\s/g, "").length / 4;
        if (beat.text.length > 35) checks.push({ code: "longDialogue", scene: sceneNumber,
          message: `第 ${beatIndex + 1} 拍台词超过 35 字。` });
        if (beat.type === "dialogue" && (typeof beat.speaker !== "string" || !characters.includes(beat.speaker))) {
          checks.push({ code: "unknownSpeaker", scene: sceneNumber, message: `第 ${beatIndex + 1} 拍说话人不在本场人物表中。` });
        }
      } else checks.push({ code: "unknownBeatType", scene: sceneNumber,
        message: `第 ${beatIndex + 1} 拍类型无效。` });
    }
    const references = Array.isArray(scene.evidence) ? scene.evidence : [];
    if (requireEvidence && !references.length) checks.push({ code: "missingEvidence", scene: sceneNumber, message: "场次缺少原文章节与行号证据。" });
    for (const reference of references) {
      const span = reference as { chapterSequence?: unknown; lineStart?: unknown; lineEnd?: unknown } | null;
      const chapter = chapters.find(item => item.sequence === span?.chapterSequence);
      if (!chapter || typeof span?.lineStart !== "number" || typeof span.lineEnd !== "number"
        || span.lineStart < chapter.lineStart || span.lineEnd > chapter.lineEnd || span.lineStart > span.lineEnd) {
        checks.push({ code: "invalidEvidence", scene: sceneNumber, message: "原文证据与章节行号不匹配。" });
      }
    }
  });
  if (targetSeconds && Math.abs(estimatedSeconds - targetSeconds) > targetSeconds * 0.15) {
    checks.push({ code: "duration", scene: null, message: `预估 ${Math.round(estimatedSeconds)} 秒，超出目标 ${targetSeconds} 秒的 ±15%。` });
  }
  return { passed: checks.length === 0, estimatedSeconds: Math.round(estimatedSeconds), checks };
}

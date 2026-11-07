import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyEpisodeDraft, ProductionCatalog, type EpisodeDraft } from "../packages/production/src/catalog";
import { checkEpisodeScript, checkSourceEvidence, indexNovel } from "../packages/production/src/novelAdaptation";

describe("小说章节索引与剧本基础检查", () => {
  const source = `第一章 雨夜\n林澄撑伞走进港口。\n她看见沈舟握着一封信。\n第二章 密信\n沈舟说信里藏着母亲的地址。\n林澄决定跟他走。`;

  test("保留原文哈希和连续行号，中文章号能识别", () => {
    const index = indexNovel(source);
    expect(index.sourceHash).toHaveLength(64);
    expect(index.chapterUnit).toBe("章");
    expect(index.chapters.map(chapter => [chapter.lineStart, chapter.lineEnd])).toEqual([[1, 3], [4, 6]]);
    expect(index.chapters[0].contentLineStart).toBe(2);
    expect(indexNovel(source + "。\n").sourceHash).not.toBe(index.sourceHash);
  });

  test("目录残留、跳章和无章标题会显式报疑点", () => {
    const contents = indexNovel(`第一章 雨夜\n第二章 密信\n第一章 雨夜\n${"正文".repeat(45)}\n第三章 追查\n${"正文".repeat(45)}`);
    expect(contents.issues.some(issue => issue.includes("不足 80 字"))).toBe(true);
    expect(contents.issues.some(issue => issue.includes("重复") || issue.includes("不连续"))).toBe(true);
    expect(indexNovel("只有正文，没有章节标题").issues).toContain("未识别到章节标题；请先确认分章边界。");
  });

  test("合法原文证据通过；错行号和未知说话人被拦截", () => {
    const chapters = indexNovel(source).chapters;
    const script = [{ scene: "港口", characters: ["林澄", "沈舟"], evidence: [{ chapterSequence: 1, lineStart: 2, lineEnd: 3 }],
      beats: [{ type: "action", text: "林澄停在雨里。" }, { type: "dialogue", speaker: "沈舟", text: "这封信给你。" }] }];
    expect(checkEpisodeScript(script, chapters).passed).toBe(true);
    const broken = [{ ...script[0], evidence: [{ chapterSequence: 1, lineStart: 5, lineEnd: 6 }],
      beats: [{ type: "dialogue", speaker: "路人", text: "这封信给你。" }] }];
    expect(checkEpisodeScript(broken, chapters).checks.map(check => check.code)).toEqual(expect.arrayContaining([
      "missingAction", "unknownSpeaker", "invalidEvidence",
    ]));
  });

  test("超长台词和偏离时长目标有明确报告", () => {
    const report = checkEpisodeScript([{ location: "港口", characters: ["林澄"],
      beats: [{ type: "action", text: "林澄转身。" }, { type: "dialogue", speaker: "林澄", text: "非常".repeat(20) }] }], [], 120, false);
    expect(report.passed).toBe(false);
    expect(report.checks.map(check => check.code)).toEqual(expect.arrayContaining(["longDialogue", "duration"]));
  });

  test("来源哈希、章节正文行号和摘录必须同时匹配", () => {
    const index = indexNovel(source);
    const evidence = { sourceHash: index.sourceHash, chapterSequence: 1, lineStart: 2, lineEnd: 2,
      quote: "林澄撑伞走进港口。" };
    expect(checkSourceEvidence(source, index, evidence)).toEqual({ valid: true });
    expect(checkSourceEvidence(source, index, { ...evidence, quote: "沈舟交出钥匙" })).toEqual({
      valid: false, reason: "原文摘录不在所引行号内。",
    });
    expect(checkSourceEvidence(source, index, { ...evidence, sourceHash: "stale" }).valid).toBe(false);
    expect(checkSourceEvidence(source, index, { ...evidence, lineStart: 1, lineEnd: 1 }).valid).toBe(false);
  });

  test("小说分集草稿只有引用真实原文才进入生产库", () => {
    const db = new Database(":memory:");
    const catalog = new ProductionCatalog(db);
    const projectId = catalog.importStory({ title: "雨夜密信", sourceKind: "novel", sourceText: source });
    const index = indexNovel(source);
    const reference = (line: number, quote: string) => ({ sourceHash: index.sourceHash,
      chapterSequence: 1, lineStart: line, lineEnd: line, quote });
    const arrival = reference(2, "林澄撑伞走进港口。");
    const letter = reference(3, "她看见沈舟握着一封信。");
    const draft: EpisodeDraft = {
      episodeNumber: 1, title: "雨夜密信", logline: "林澄在港口遇见持信的沈舟。",
      outline: ["林澄抵达港口", "沈舟持信出现"],
      script: [{ location: "港口", characters: ["林澄", "沈舟"], evidence: [arrival, letter],
        beats: [{ type: "action", text: "林澄撑伞进入港口。" },
          { type: "dialogue", speaker: "沈舟", text: "这封信是给你的。" }] }],
      scenes: [{ name: "港口", location: "海边", atmosphere: "雨夜", timeWeather: "夜雨", evidence: [arrival] }],
      characters: [
        { name: "林澄", aliases: [], stableDescription: "撑伞的女子", evidence: [arrival], firstAppearance: "第一章" },
        { name: "沈舟", aliases: [], stableDescription: "握着信的男子", evidence: [letter], firstAppearance: "第一章" },
      ],
      props: [{ name: "信", aliases: [], stableDescription: "一封信", evidence: [letter], firstAppearance: "第一章" }],
      shots: [{ sequence: 1, sceneName: "港口", title: "雨中遇信", scriptExcerpt: "她看见沈舟握着一封信。",
        evidence: [letter], durationMs: 5000, shotSize: "MS", movement: "固定", promptText: "",
        characterNames: ["林澄", "沈舟"], propUses: [{ name: "信", holderBeforeName: "沈舟", holderAfterName: "沈舟",
          stateBefore: "握在手中", stateAfter: "握在手中", interaction: "沈舟展示信", evidence: [letter] }], dialogue: [] }],
    };
    expect(applyEpisodeDraft(catalog, projectId, draft).shotIds).toHaveLength(1);
    const invented = { ...draft, episodeNumber: 2,
      shots: [{ ...draft.shots[0]!, evidence: [reference(3, "沈舟打开银色匣子。") ] }] };
    expect(() => applyEpisodeDraft(catalog, projectId, invented)).toThrow("原文摘录不在所引行号内");
    const staleScript = { ...draft, episodeNumber: 2,
      script: [{ ...draft.script[0] as Record<string, unknown>, evidence: [{ ...arrival, sourceHash: "stale" }] }] };
    expect(() => applyEpisodeDraft(catalog, projectId, staleScript)).toThrow("来源哈希不匹配");
    expect(catalog.listEpisodes(projectId)).toHaveLength(1);
    db.close();
  });
});

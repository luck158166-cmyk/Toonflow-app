import { describe, expect, test } from "bun:test";
import { checkEpisodeScript, indexNovel } from "../packages/production/src/novelAdaptation";

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
});

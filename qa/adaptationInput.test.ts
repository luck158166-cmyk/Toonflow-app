import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionCatalog } from "../packages/production/src/catalog";
import { prepareAdaptationInput } from "../packages/production/src/adaptationInput";

const sourceText = `第一章 雨夜\r\n${"林岚在车站寻找父亲留下的铜钥匙。".repeat(7)}\r\n第二章 来信\r\n${"周明带着信封走来，林岚接过信封。".repeat(7)}`;
const options = { episodeNumber: 1, firstChapter: 2, lastChapter: 2, targetSeconds: 60,
  genre: "悬疑", visualStyle: "三维动画" };

it("persists an immutable numbered source snapshot and reuses it after database reopen", () => {
  const folder = mkdtempSync(join(tmpdir(), "adaptationInput"));
  let db = new Database(join(folder, "project.db"));
  try {
    let catalog = new ProductionCatalog(db);
    const id = catalog.importStory({ title: "来信", sourceKind: "novel", sourceText });
    const first = prepareAdaptationInput(catalog, id, options, { type: "object" });
    const request = JSON.parse(first.requestJson);
    expect(request.source).toHaveLength(1);
    expect(request.source[0].sequence).toBe(2);
    expect(request.source[0].lines[0]).toEqual({ line: 4, text: sourceText.split("\r\n")[3] });
    expect(request.options.targetSeconds).toBe(60);
    db.close(); db = new Database(join(folder, "project.db")); catalog = new ProductionCatalog(db);
    expect(prepareAdaptationInput(catalog, id, options, { type: "object" })).toEqual(first);
    expect(catalog.getProjectProduction(id).adaptationInputs).toHaveLength(1);
    const revised = prepareAdaptationInput(catalog, id, { ...options, visualStyle: "水墨" }, { type: "object" });
    expect(revised.id).not.toBe(first.id);
    expect(catalog.getProjectProduction(id).adaptationInputs).toHaveLength(2);
    expect(db.query("SELECT request_json AS value FROM adaptation_input WHERE id = ?").get(first.id)).toEqual({ value: first.requestJson });
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

it("blocks missing prior episodes, unconfirmed memory, chapter errors and oversized input without partial snapshots", () => {
  const db = new Database(":memory:");
  try {
    const catalog = new ProductionCatalog(db);
    const id = catalog.importStory({ title: "来信", sourceKind: "novel", sourceText });
    expect(() => prepareAdaptationInput(catalog, id, { ...options, lastChapter: 3 }, {})).toThrow("章节范围");
    expect(() => prepareAdaptationInput(catalog, id, { ...options, episodeNumber: 2 }, {})).toThrow("前序分集");
    catalog.createEpisode(id, 1, "第一集");
    expect(() => prepareAdaptationInput(catalog, id, { ...options, episodeNumber: 2 }, {})).toThrow("前序分集");
    const short = catalog.importStory({ title: "短文", sourceKind: "novel", sourceText: "第一章\n很短。" });
    expect(() => prepareAdaptationInput(catalog, short, { ...options, firstChapter: 1, lastChapter: 1 }, {})).toThrow("原文分章");
    const long = catalog.importStory({ title: "长文", sourceKind: "novel", sourceText: "第一章\n" + "故事".repeat(70000) });
    expect(() => prepareAdaptationInput(catalog, long, { ...options, firstChapter: 1, lastChapter: 1 }, {})).toThrow("没有被截断");
    expect(db.query("SELECT COUNT(*) AS count FROM adaptation_input").get()).toEqual({ count: 0 });
  } finally { db.close(); }
});

it("carries confirmed prior script, stable asset identities and the last prop state into the next episode", () => {
  const db = new Database(":memory:");
  try {
    const catalog = new ProductionCatalog(db);
    const projectId = catalog.importStory({ title: "来信", sourceKind: "novel", sourceText });
    const episodeId = catalog.createEpisode(projectId, 1, "雨夜");
    catalog.saveEpisodeScript(episodeId, [{ location: "车站", beats: [{ type: "action", text: "林岚拾起钥匙" }] }], "confirmed");
    const person = catalog.upsertAsset({ projectId, kind: "character", name: "林岚", aliases: ["小岚"], stableDescription: "黑发", evidence: ["原文"] });
    const prop = catalog.upsertAsset({ projectId, kind: "prop", name: "钥匙", evidence: ["原文"] });
    const shotId = catalog.createShot({ projectId, episodeId, sequence: 1, scriptExcerpt: "拾起钥匙", evidence: ["原文"] });
    catalog.linkPropToShot({ shotId, propId: prop, holderAfterId: person, stateBefore: "地面", stateAfter: "手中", interaction: "拾起", evidence: ["原文"] });
    const prepared = prepareAdaptationInput(catalog, projectId, { ...options, episodeNumber: 2 }, {});
    const memory = JSON.parse(prepared.requestJson).continuity;
    expect(memory.priorEpisodes[0].title).toBe("雨夜");
    expect(memory.assets.find((item: { id: string }) => item.id === person).aliases).toEqual(["小岚"]);
    expect(memory.propStates[0]).toMatchObject({ propId: prop, holderId: person, state: "手中", episodeNumber: 1 });
  } finally { db.close(); }
});

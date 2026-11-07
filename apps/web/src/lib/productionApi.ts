import axios from "axios";

export type SourceKind = "synopsis" | "novel" | "script";
export type Story = { id: string; title: string; sourceKind: SourceKind; workflowState: string; createdAt: number; updatedAt: number };
export type StoryDetail = Story & { sourceText: string };
export type StorySummary = { id: string; title: string; sourceKind: SourceKind; description: string;
  chapterCount: number; episodeCount: number; characterCount: number; sceneCount: number;
  propCount: number; shotCount: number; updatedAt: number };
export type Episode = { id: string; projectId: string; episodeNumber: number; title: string; logline: string;
  reviewState: string; createdAt: number; updatedAt: number; shotCount?: number };
export type EpisodeCost = { episode: Episode; breakdown: Array<{ shotId: string | null; stage: string;
  provider: string; modelId: string; currency: string; chargedMicros: number; reservedMicros: number }>;
  charges: Array<{ taskId: string; shotId: string | null; stage: string; provider: string; modelId: string;
    sourceRef: string; amountMicros: number; currency: string; status: "reconciled" | "manual";
    pricingRef: string | null; unit: string | null; units: number | null; unitPriceMicros: number | null;
    createdAt: number }> };
export type ProjectProduction = { story: StoryDetail;
  chapterIndex: { sourceHash: string; lineCount: number; chapterUnit: "章" | "回" | "节" | null;
    chapters: Array<{ sequence: number; title: string; lineStart: number; lineEnd: number;
      contentLineStart: number; characterCount: number }>;
    issues: string[] } | null;
  analysis: { events: unknown[]; relations: unknown[]; version: number; updatedAt: number } | null;
  episodes: Array<Episode & { outline: string[]; script: unknown[];
    scriptReport: { passed: boolean; estimatedSeconds: number;
      checks: Array<{ code: string; scene: number | null; message: string }> } }>;
  assets: Array<{ id: string; kind: "character" | "prop" | "costume"; name: string;
    aliases: string[]; stableDescription: string; evidence: unknown[]; firstAppearance: string;
    variantOf: string | null; locked: boolean }>;
  scenes: Array<{ id: string; name: string; location: string; atmosphere: string;
    timeWeather: string; evidence: unknown[]; locked: boolean }>;
  shots: Array<{ id: string; episodeId: string; episodeNumber: number; sequence: number;
    sceneId: string | null; title: string; scriptExcerpt: string; evidence: unknown[];
    shotSize: string; cameraAngle: string; movement: string; durationMs: number;
    promptText: string; promptVersion: number; reviewState: string; runtimeState: string;
    videoReadiness: string }>;
  shotProps: Array<{ shotId: string; propId: string; propName: string;
    holderBeforeId: string | null; holderBeforeName: string | null;
    holderAfterId: string | null; holderAfterName: string | null;
    stateBefore: string; stateAfter: string; interaction: string; evidence: unknown[] }>;
  tasks: Array<{ id: string; episodeId: string; shotId: string | null; stage: string;
    provider: string; modelId: string; state: string; billable: number;
    estimatedCostMicros: number; currency: string; reservedMicros: number;
    chargedMicros: number; outputCount: number; createdAt: number; updatedAt: number }> };
export type PriceRule = { id: string; provider: string; modelId: string; unit: string; unitSize: number;
  unitPriceMicros: number; currency: string; sourceUrl: string; effectiveAt: number; recordedBy: string; createdAt: number };
export type PriceRuleInput = Pick<PriceRule, "provider" | "modelId" | "unit" | "unitSize" | "unitPriceMicros" | "currency" | "sourceUrl" | "effectiveAt">;
export type BudgetUsage = { configured: boolean; scope: { type: string; key: string }; currency: string | null;
  limitMicros: number; warningBasisPoints: number; chargedMicros: number; reservedMicros: number; usedMicros: number };
export type BudgetChange = { id: string; scopeType: string; scopeKey: string; previousLimitMicros: number | null;
  previousCurrency: string | null; previousWarningBasisPoints: number | null; limitMicros: number;
  currency: string; warningBasisPoints: number; recordedBy: string; changedAt: number };
export type BudgetOverview = { global: BudgetUsage; globalHistory: BudgetChange[];
  project: BudgetUsage | null; projectHistory: BudgetChange[] };

const client = axios.create({ baseURL: "/api/production", headers: { "x-toonflow-workspace": "1" } });

const productionApi = {
  async listStorySummaries(directory: string) {
    const { data } = await client.get<{ data: { stories: StorySummary[] } }>("/listStorySummaries", { params: { directory } });
    return data.data.stories;
  },
  async listStories(directory: string) {
    const { data } = await client.get<{ data: { stories: Story[] } }>("/listStories", { params: { directory } });
    return data.data.stories;
  },
  async getStory(directory: string, projectId: string) {
    const { data } = await client.get<{ data: { story: StoryDetail } }>("/getStory", { params: { directory, projectId } });
    return data.data.story;
  },
  async importStory(directory: string, title: string, sourceKind: SourceKind, sourceText: string) {
    const { data } = await client.post<{ data: { projectId: string } }>("/importStory", { directory, title, sourceKind, sourceText });
    return data.data.projectId;
  },
  async listEpisodes(directory: string, projectId: string) {
    const { data } = await client.get<{ data: { episodes: Episode[] } }>("/listEpisodes", { params: { directory, projectId } });
    return data.data.episodes;
  },
  async createEpisode(directory: string, projectId: string, episodeNumber: number, title: string, logline: string) {
    const { data } = await client.post<{ data: { episode: Episode } }>("/createEpisode",
      { directory, projectId, episodeNumber, title, logline });
    return data.data.episode;
  },
  async getEpisodeCost(directory: string, projectId: string, episodeId: string) {
    const { data } = await client.get<{ data: EpisodeCost }>("/getEpisodeCost",
      { params: { directory, projectId, episodeId } });
    return data.data;
  },
  async getProjectProduction(directory: string, projectId: string) {
    const { data } = await client.get<{ data: ProjectProduction }>("/getProjectProduction",
      { params: { directory, projectId } });
    return data.data;
  },
  async exportBackup(directory: string) {
    const { data } = await client.get<Blob>("/exportBackup", { params: { directory }, responseType: "blob" });
    return data;
  },
  async listPriceRules(directory: string) {
    const { data } = await client.get<{ data: { rules: PriceRule[] } }>("/listPriceRules", { params: { directory } });
    return data.data.rules;
  },
  async recordPriceRule(directory: string, input: PriceRuleInput) {
    const { data } = await client.post<{ data: { rule: PriceRule } }>("/recordPriceRule", { directory, ...input });
    return data.data.rule;
  },
  async getBudget(directory: string, projectId?: string) {
    const { data } = await client.get<{ data: BudgetOverview }>("/getBudget", { params: { directory, projectId } });
    return data.data;
  },
  async setBudget(directory: string, input: { scopeType: "global" | "project"; projectId?: string;
    limitMicros: number; currency: string; warningBasisPoints: number }) {
    const { data } = await client.post<{ data: { usage: BudgetUsage } }>("/setBudget", { directory, ...input });
    return data.data.usage;
  },
};

export default productionApi;

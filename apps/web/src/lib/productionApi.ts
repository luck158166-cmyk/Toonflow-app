import axios from "axios";
export type AdaptationInputSummary = { id: string; episodeNumber: number; sourceHash: string; templateVersion: string; createdAt: number };
export type AdaptationRequest = { directory: string; projectId: string; inputId: string; providerId: string; modelId: string; maxOutputTokens: number };
export type AdaptationPreview = { planHash: string; estimatedCostMicros: number; sourceUrl: string; destination: string;
  quantity: number; requestJson: string; options: { episodeNumber: number; firstChapter: number; lastChapter: number;
    targetSeconds: number; genre: string; visualStyle: string } };
export type ProductionTextModel = { providerId: string; providerLabel: string; modelId: string; label: string; maxOutputTokens: number };
export type ReferenceRole = "headshot" | "fullBody" | "scene" | "prop" | "costume";
export type AssetImageRequest = { directory: string; projectId: string; entityKind: "asset" | "scene"; entityId: string; role: ReferenceRole; visualStyle: string };
export type AssetImagePreview = { planHash: string; canSubmit: boolean; requestJson: string; destination: string; episodeNumber: number;
  blockers: string[]; price: { amountMicros: number; sourceUrl: string } | null; adoptedReferenceId: string | null;
  existingTask: { id: string; state: string; requestStarted: boolean } | null };
export type AssetReference = { id: string; projectId: string; entityKind: "asset" | "scene"; entityId: string;
  entityHash: string; role: ReferenceRole; version: number; previousId: string | null; path: string;
  sha256: string; mimeType: string; width: number; height: number; sourceNote: string;
  sourceKind: "user_authorized"; createdAt: number };
export type ReferenceTarget = { entityKind: "asset" | "scene"; entityId: string; name: string; kind: string;
  description: string; locked: boolean; entityHash: string; roles: ReferenceRole[] };
export type ShotPreparation = { inputHash: string; issues: Array<{ code: string; message: string; entityId?: string }>;
  history: Array<{ id: string; version: number; inputHash: string; createdAt: number }>;
  snapshot: { shot: { id: string; sequence: number; title: string; scriptExcerpt: string; durationMs: number; shotSize: string; movement: string; promptText: string };
    references: Array<{ index: number; entityId: string; name: string; role: ReferenceRole; description: string; reference: AssetReference | null }>;
    characters: Array<{ id: string; name: string; costumeId: string | null }>;
    dialogue: Array<{ id: string; speakerId: string | null; speakerName: string | null; kind: string; text: string; emotion: string }>;
    dialogueTiming: { charactersPerSecond: number; estimatedSeconds: number };
    props: Array<{ propId: string; propName: string; holderBeforeName: string | null; holderAfterName: string | null; stateBefore: string; stateAfter: string; interaction: string }>;
    continuity: { previousShot: { title: string; scriptExcerpt: string } | null; nextShot: { title: string; scriptExcerpt: string } | null } } };

export type CompiledShotPrompt = { inputHash: string; canSave: boolean; readyForGeneration: false;
  fileIssues: Array<{ code: string; message: string }>;
  history: Array<{ id: string; version: number; inputHash: string; createdAt: number }>;
  snapshot: { templateVersion: string; preparationHash: string;
    requestDraft: { model: string; duration: number; ratio: string; resolution: string; prompt: string };
    checks: Array<{ code: string; state: "passed" | "failed" | "pending"; message: string }> } };
export type SourceKind = "synopsis" | "novel" | "script";
export type SegmentExecutionRequest = { directory: string; projectId: string; episodeId: string; inputHash: string; sequence: number };
export type SegmentExecutionPreview = { planHash: string; canSubmit: boolean; requestJson: string; destination: string;
  review: { id: string; note: string; createdAt: number } | null; blockers: Array<{ code: string; message: string }>;
  price: { estimatedCostMicros: number; sourceUrl: string; quantity: number } | null;
  references: SegmentPlan["snapshot"]["segments"][number]["references"];
  existingTask: { id: string; state: string; requestStarted: boolean } | null };
export type SegmentPlan = { inputHash: string; canSave: boolean; readyForGeneration: false;
  fileIssues: Array<{ message: string }>; history: Array<{ id: string; version: number; inputHash: string; createdAt: number }>;
  snapshot: { segments: Array<{ sequence: number; sceneSequence: number | null; boundaryReason: string;
    timeline: Array<{ shotId: string; sequence: number; title: string; start: number; end: number }>;
    references: Array<{ index: number; name: string; role: ReferenceRole; reference: AssetReference | null }>;
    requestDraft: { duration: number; prompt: string };
    checks: Array<{ code: string; state: "passed" | "failed" | "pending"; message: string }> }> } };
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
  assetReferences: AssetReference[];
  adaptationAdoptions: Array<{ taskId: string; episodeId: string }>;
  adaptationInputs: AdaptationInputSummary[];
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
    chargedMicros: number; outputCount: number; createdAt: number; updatedAt: number;
    hostTaskId?: string | null; segmentKey?: string | null }> };
export type EpisodeReview = { snapshotHash: string; sourceText: string; issues: string[]; hasSuccessor: boolean;
  snapshot: { sourceHash: string; episode: ProjectProduction["episodes"][number];
    shots: Array<Omit<ProjectProduction["shots"][number], "runtimeState" | "videoReadiness">>;
    assets: ProjectProduction["assets"]; scenes: ProjectProduction["scenes"]; props: ProjectProduction["shotProps"];
    characters: Array<{ shotId: string; characterId: string; costumeId: string | null }>;
    dialogue: Array<{ id: string; shotId: string; sequence: number; kind: string; speakerId: string | null;
      listenerId: string | null; text: string; emotion: string; voiceProfile: string }> };
  history: Array<{ id: string; decision: "confirmed" | "changes_requested"; note: string; reviewedBy: string; createdAt: number }> };
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
  async previewAssetImage(input: AssetImageRequest) {
    const { data } = await client.post<{ data: AssetImagePreview }>("/previewAssetImage", input); return data.data;
  },
  async runAssetImage(input: AssetImageRequest, approval: { approved: true; maxCalls: 1; planHash: string; maxCostMicros: number }) {
    const { data } = await client.post<{ data: { taskId: string; state: string; message: string } }>("/runAssetImage", { ...input, approval }); return data.data;
  },
  async recoverAssetImage(directory: string, projectId: string, taskId: string) {
    const { data } = await client.post<{ data: { state: string; message: string } }>("/recoverAssetImage", { directory, projectId, taskId }); return data.data;
  },
  async readAssetImage(directory: string, projectId: string, taskId: string) {
    const { data } = await client.get<Blob>("/readAssetImage", { params: { directory, projectId, taskId }, responseType: "blob" }); return data;
  },
  async adoptAssetImage(directory: string, projectId: string, taskId: string) {
    await client.post("/adoptAssetImage", { directory, projectId, taskId, rightsConfirmed: true });
  },
  async previewSegmentVideo(input: SegmentExecutionRequest) {
    const { data } = await client.post<{ data: SegmentExecutionPreview }>("/previewSegmentVideo", input); return data.data;
  },
  async reviewSegmentPreflight(input: SegmentExecutionRequest, review: { actionConfirmed: true; continuityConfirmed: true; dialogueConfirmed: true; referencesConfirmed: true; note: string }) {
    await client.post("/reviewSegmentPreflight", { ...input, review });
  },
  async runSegmentVideo(input: SegmentExecutionRequest, approval: { approved: true; maxCalls: 1; planHash: string; maxCostMicros: number }) {
    const { data } = await client.post<{ data: { taskId: string; state: string; message: string } }>("/runSegmentVideo", { ...input, approval }); return data.data;
  },
  async getSegmentPlan(directory: string, projectId: string, episodeId: string) {
    const { data } = await client.get<{ data: SegmentPlan }>("/getSegmentPlan", { params: { directory, projectId, episodeId } });
    return data.data;
  },
  async saveSegmentPlan(directory: string, projectId: string, episodeId: string, inputHash: string) {
    const { data } = await client.post<{ data: { id: string; version: number; created: boolean } }>("/saveSegmentPlan", { directory, projectId, episodeId, inputHash });
    return data.data;
  },
  async getShotPrompt(directory: string, projectId: string, shotId: string) {
    const { data } = await client.get<{ data: CompiledShotPrompt }>("/getShotPrompt", { params: { directory, projectId, shotId } });
    return data.data;
  },
  async saveShotPrompt(directory: string, projectId: string, shotId: string, inputHash: string) {
    const { data } = await client.post<{ data: { id: string; version: number; created: boolean } }>("/saveShotPrompt", { directory, projectId, shotId, inputHash });
    return data.data;
  },
  async getShotPreparation(directory: string, projectId: string, shotId: string) {
    const { data } = await client.get<{ data: ShotPreparation }>("/getShotPreparation", { params: { directory, projectId, shotId } });
    return data.data;
  },
  async saveShotPreparation(directory: string, projectId: string, shotId: string, inputHash: string) {
    const { data } = await client.post<{ data: { id: string; version: number; inputHash: string; created: boolean } }>("/saveShotPreparation", { directory, projectId, shotId, inputHash });
    return data.data;
  },
  async getAssetReferences(directory: string, projectId: string) {
    const { data } = await client.get<{ data: { targets: ReferenceTarget[]; references: AssetReference[] } }>("/getAssetReferences", { params: { directory, projectId } });
    return data.data;
  },
  async bindAssetReference(directory: string, input: { projectId: string; entityKind: "asset" | "scene"; entityId: string;
    entityHash: string; role: ReferenceRole; expectedReferenceId: string | null; rightsConfirmed: true;
    sourceNote: string; path: string; sha256: string }) {
    const { data } = await client.post<{ data: { reference: AssetReference; created: boolean } }>("/bindAssetReference", { directory, ...input });
    return data.data;
  },
  async readAssetReference(directory: string, projectId: string, referenceId: string) {
    const { data } = await client.get<Blob>("/readAssetReference", { params: { directory, projectId, referenceId }, responseType: "blob" });
    return data;
  },
  async getEpisodeReview(directory: string, projectId: string, episodeId: string) {
    const { data } = await client.get<{ data: EpisodeReview }>("/getEpisodeReview", { params: { directory, projectId, episodeId } });
    return data.data;
  },
  async reviewEpisode(directory: string, projectId: string, episodeId: string, snapshotHash: string,
    decision: "confirmed" | "changes_requested", note: string) {
    const { data } = await client.post<{ data: { reviewId: string; alreadyReviewed: boolean } }>("/reviewEpisode",
      { directory, projectId, episodeId, snapshotHash, decision, note });
    return data.data;
  },
  async listTextModels() {
    const { data } = await axios.get<{ data: ProductionTextModel[] }>("/api/ai/models");
    return data.data;
  },
  async previewAdaptation(input: AdaptationRequest) {
    const { data } = await client.post<{ data: AdaptationPreview }>("/previewAdaptation", input);
    return data.data;
  },
  async runAdaptation(input: AdaptationRequest, approval: { approved: true; maxCalls: 1; planHash: string; maxCostMicros: number }) {
    const { data } = await client.post<{ data: { taskId: string; status: string; episodeId?: string; adoptionError?: string } }>("/runAdaptation", { ...input, approval });
    return data.data;
  },
  async adoptTextResult(directory: string, projectId: string, taskId: string) {
    const { data } = await client.post<{ data: { episodeId: string; alreadyAdopted: boolean } }>("/adoptTextResult", { directory, projectId, taskId });
    return data.data;
  },
  async prepareAdaptation(directory: string, projectId: string, options: { episodeNumber: number;
    firstChapter: number; lastChapter: number; targetSeconds: number; genre: string; visualStyle: string }) {
    const { data } = await client.post<{ data: AdaptationInputSummary }>("/prepareAdaptation", { directory, projectId, options });
    return data.data;
  },
  async adoptEpisodeDraft(directory: string, projectId: string, sourceHash: string, draft: unknown) {
    await client.post("/adoptEpisodeDraft", { directory, projectId, sourceHash, draft });
  },
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
  async recoverVideoTask(directory: string, projectId: string, taskId: string) {
    const { data } = await client.post<{ data: { state: string; message: string } }>("/recoverVideoTask", { directory, projectId, taskId });
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

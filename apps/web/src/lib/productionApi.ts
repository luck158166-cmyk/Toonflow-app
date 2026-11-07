import axios from "axios";

export type SourceKind = "synopsis" | "novel" | "script";
export type Story = { id: string; title: string; sourceKind: SourceKind; workflowState: string; createdAt: number; updatedAt: number };
export type StoryDetail = Story & { sourceText: string };
export type PriceRule = { id: string; provider: string; modelId: string; unit: string; unitSize: number;
  unitPriceMicros: number; currency: string; sourceUrl: string; effectiveAt: number; recordedBy: string; createdAt: number };
export type PriceRuleInput = Pick<PriceRule, "provider" | "modelId" | "unit" | "unitSize" | "unitPriceMicros" | "currency" | "sourceUrl" | "effectiveAt">;

const client = axios.create({ baseURL: "/api/production", headers: { "x-toonflow-workspace": "1" } });

const productionApi = {
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
  async listPriceRules(directory: string) {
    const { data } = await client.get<{ data: { rules: PriceRule[] } }>("/listPriceRules", { params: { directory } });
    return data.data.rules;
  },
  async recordPriceRule(directory: string, input: PriceRuleInput) {
    const { data } = await client.post<{ data: { rule: PriceRule } }>("/recordPriceRule", { directory, ...input });
    return data.data.rule;
  },
};

export default productionApi;

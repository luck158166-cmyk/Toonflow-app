import { z } from "zod";

export const segmentExecutionFields = { directory: z.string().min(1).max(4096), projectId: z.uuid(), episodeId: z.uuid(),
  sequence: z.number().int().positive().max(10000), inputHash: z.string().regex(/^[a-f0-9]{64}$/) };

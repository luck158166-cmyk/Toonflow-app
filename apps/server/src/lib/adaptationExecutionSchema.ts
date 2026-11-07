import { z } from "zod";

export const adaptationExecutionFields = {
  directory: z.string().min(1).max(4096), projectId: z.uuid(), inputId: z.string().regex(/^[a-f0-9]{64}$/),
  providerId: z.string().trim().min(1).max(300), modelId: z.string().trim().min(1).max(300),
  maxOutputTokens: z.number().int().min(1).max(1_000_000),
};

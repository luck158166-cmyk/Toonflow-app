import { z } from "zod";
export const assetImageFields = { directory: z.string().min(1).max(4096), projectId: z.uuid(), entityKind: z.enum(["asset", "scene"]),
  entityId: z.uuid(), role: z.enum(["headshot", "fullBody", "scene", "prop", "costume"]), visualStyle: z.string().max(120) };
export const assetImageTaskFields = { directory: z.string().min(1).max(4096), projectId: z.uuid(), taskId: z.uuid() };

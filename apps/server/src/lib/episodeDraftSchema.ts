import { z } from "zod";
import { cameraMoves } from "@toonflow/production";

const name = z.string().min(1).max(200);
const text = z.string().max(10000);
const evidence = z.array(z.union([z.string().min(1).max(2000), z.object({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), chapterSequence: z.number().int().positive(),
  lineStart: z.number().int().positive(), lineEnd: z.number().int().positive(), quote: z.string().min(2).max(2000),
}).strict()])).min(1).max(100);
const asset = z.object({ name, aliases: z.array(name).max(50), stableDescription: text,
  firstAppearance: text, evidence }).strict();
const direction = z.object({ summary: z.string().trim().min(1).max(1200), action: z.string().trim().min(1).max(1200),
  camera: z.enum(cameraMoves), positions: z.array(z.object({ name, start: z.string().trim().min(1).max(400),
    end: z.string().trim().min(1).max(400) }).strict()).max(100), environment: z.string().trim().min(1).max(1200),
  style: z.string().trim().min(1).max(1200), sound: z.string().max(1200) }).strict();

/** Boundary shared by imported drafts and future model output adapters. */
export const episodeDraftSchema = z.object({
  episodeNumber: z.number().int().positive().safe(), title: name, logline: text,
  outline: z.array(name).min(1).max(200),
  script: z.array(z.object({ location: name, characters: z.array(name).max(100), evidence,
    beats: z.array(z.object({ type: z.enum(["action", "dialogue", "voiceover"]),
      text, speaker: name.optional(), evidence: evidence.optional() }).strict()).min(1).max(500),
  }).strict()).min(1).max(200),
  scenes: z.array(z.object({ name, location: text, atmosphere: text, timeWeather: text, evidence }).strict()).min(1).max(200),
  characters: z.array(asset).max(200), props: z.array(asset).max(500).optional(),
  shots: z.array(z.object({ sequence: z.number().int().positive(), sceneName: name, title: name,
    scriptExcerpt: text, evidence, durationMs: z.number().int().min(1).max(600000),
    shotSize: text, movement: text, promptText: text, characterNames: z.array(name).max(100),
    direction: direction.optional(),
    propUses: z.array(z.object({ name, holderBeforeName: name.optional(), holderAfterName: name.optional(),
      stateBefore: text, stateAfter: text, interaction: text, evidence }).strict()).max(100).optional(),
    dialogue: z.array(z.object({ kind: z.enum(["dialogue", "narration", "voiceover", "phone"]),
      speakerName: name.optional(), listenerName: name.optional(), text,
      emotion: text.optional(), voiceProfile: text.optional() }).strict()).max(200),
  }).strict()).min(1).max(200),
}).strict();

// New model inputs require director fields; historical drafts remain readable through the base schema.
export const directedEpisodeSchema = episodeDraftSchema.extend({ shots: z.array(
  episodeDraftSchema.shape.shots.element.extend({ direction })).min(1).max(200) });

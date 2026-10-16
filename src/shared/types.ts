import { z } from "zod";

export const activityStateSchema = z.enum(["starting", "thinking", "tooling", "editing", "idle", "error"]);

export const presencePayloadSchema = z.object({
  app: z.literal("pi-coding-agent"),
  provider: z.string().min(1).default("unknown"),
  model: z.string().min(1).default("unknown"),
  state: activityStateSchema.default("idle"),
  projectName: z.string().optional(),
  startedAt: z.number().int().positive(),
  sessionId: z.string().min(1).optional(),
  /**
   * When the user last started work in this session, in milliseconds.
   *
   * The only user-driven moment a session can report. It is kept apart from any
   * other activity so the foreground session follows the user and not the noisiest
   * process: a background session running its own tools must not steal the display
   * from the session the user is actually working in.
   */
  lastPromptAtMs: z.number().int().positive().optional(),
  /** Live sessions behind the single presence the helper publishes. */
  agents: z.number().int().nonnegative().optional(),
  /** Live subagents those sessions have running, taken from their task records. */
  subagents: z.number().int().nonnegative().optional(),
  privacyMode: z.boolean().default(true)
});

export type ActivityState = z.infer<typeof activityStateSchema>;
export type PresencePayload = z.infer<typeof presencePayloadSchema>;

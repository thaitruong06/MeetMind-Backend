import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(8080),
  GCP_PROJECT_ID: z.string().min(1),
  STORAGE_BUCKET: z.string().min(1),
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  MAX_AUDIO_MB: z.coerce.number().default(200),
});

export const config = schema.parse(process.env);
export const MAX_AUDIO_BYTES = config.MAX_AUDIO_MB * 1024 * 1024;
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

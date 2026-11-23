import { GoogleGenAI } from "@google/genai";
import type { z } from "zod";
import { config } from "../config.js";
import { AppError } from "../errors.js";

/** Gemini chỉ được gọi từ backend. Khóa nằm ở biến môi trường/Secret Manager, không bao giờ xuống APK. */
const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callModel(system: string, prompt: string, json: boolean): Promise<string> {
  if (!config.GEMINI_API_KEY) {
    throw new AppError(502, "AI_UPSTREAM_ERROR", "Chưa cấu hình GEMINI_API_KEY");
  }
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model: config.GEMINI_MODEL,
        contents: prompt,
        config: {
          systemInstruction: system,
          temperature: 0.2,
          ...(json ? { responseMimeType: "application/json" } : {}),
        },
      });
      const text = res.text;
      if (!text) throw new Error("empty");
      return text;
    } catch (e) {
      lastStatus = Number((e as { status?: number }).status ?? 0);
      // 429 (hết hạn mức free tier) và 503 thì chờ rồi thử lại; lỗi khác dừng ngay.
      if (lastStatus !== 429 && lastStatus !== 503 && lastStatus !== 0) break;
      await sleep(1500 * (attempt + 1) ** 2);
    }
  }
  if (lastStatus === 429) {
    throw new AppError(502, "QUOTA_EXCEEDED", "Hết hạn mức Gemini, thử lại sau");
  }
  throw new AppError(502, "AI_UPSTREAM_ERROR", "Gemini lỗi");
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function generateJson<T>(system: string, prompt: string, schema: z.ZodType<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callModel(system, prompt, true);
    try {
      return schema.parse(JSON.parse(stripFences(raw)));
    } catch {
      // thử lại 1 lần nếu JSON sai schema
    }
  }
  throw new AppError(502, "AI_OUTPUT_INVALID", "Gemini trả về dữ liệu sai định dạng");
}

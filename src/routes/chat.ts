import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { iso, loadMeeting, parse } from "../util.js";
import { generateJson } from "../services/gemini.js";
import { transcriptAsText } from "../services/transcript.js";
import { CHAT_SYSTEM } from "../services/prompts.js";

const chatLimit = { rateLimit: { max: 15, timeWindow: "1 minute" } };
const body = z.object({ message: z.string().trim().min(1, "Câu hỏi không được trống").max(1000) });
const answerSchema = z.object({
  answer: z.string(),
  citations: z
    .array(z.object({ startMs: z.number(), quote: z.string() }))
    .max(3)
    .default([]),
});

export async function chatRoutes(app: FastifyInstance) {
  // Chat đồng bộ (200). Lịch sử lưu theo từng người dùng.
  app.post("/meetings/:id/chat", { preHandler: requireAuth(), config: chatLimit }, async (req) => {
    const { id } = req.params as { id: string };
    const { message } = parse(body, req.body);
    const m = await loadMeeting(id, req.uid);
    const transcript = await transcriptAsText(m.ref);

    const histSnap = await m.ref
      .collection("chatMessages")
      .where("uid", "==", req.uid)
      .orderBy("createdAt", "desc")
      .limit(8)
      .get();
    const history = histSnap.docs
      .reverse()
      .map((d) => `${d.data().role === "user" ? "Người dùng" : "Trợ lý"}: ${d.data().text}`)
      .join("\n");

    const prompt = `Transcript:\n${transcript}\n\nLịch sử hội thoại:\n${history || "(chưa có)"}\n\nCâu hỏi: ${message}`;
    const out = await generateJson(CHAT_SYSTEM, prompt, answerSchema);

    const col = m.ref.collection("chatMessages");
    const batch = m.ref.firestore.batch();
    const now = Date.now();
    batch.set(col.doc(), { uid: req.uid, role: "user", text: message, createdAt: new Date(now) });
    batch.set(col.doc(), {
      uid: req.uid,
      role: "assistant",
      text: out.answer,
      citations: out.citations,
      createdAt: new Date(now + 1),
    });
    await batch.commit();
    return { answer: out.answer, citations: out.citations };
  });

  app.get("/meetings/:id/chat", { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    const m = await loadMeeting(id, req.uid);
    const snap = await m.ref
      .collection("chatMessages")
      .where("uid", "==", req.uid)
      .orderBy("createdAt", "asc")
      .limit(200)
      .get();
    return {
      items: snap.docs.map((d) => {
        const x = d.data();
        return {
          id: d.id,
          role: x.role,
          text: x.text,
          citations: x.citations ?? [],
          createdAt: x.createdAt?.toDate ? iso(x.createdAt) : null,
        };
      }),
      nextCursor: null,
    };
  });

  app.delete("/meetings/:id/chat", { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const m = await loadMeeting(id, req.uid);
    const snap = await m.ref.collection("chatMessages").where("uid", "==", req.uid).get();
    const batch = m.ref.firestore.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    return reply.code(204).send();
  });
}


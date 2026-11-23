import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { notFound } from "../errors.js";
import { loadMeeting, parse } from "../util.js";
import { loadLines, loadSpeakers } from "../services/transcript.js";

const speakerBody = z.object({ name: z.string().trim().min(1, "Tên không được trống").max(60) });

export async function transcriptRoutes(app: FastifyInstance) {
  app.get("/meetings/:id/transcript", { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    const m = await loadMeeting(id, req.uid);
    const [lines, speakers] = await Promise.all([loadLines(m.ref), loadSpeakers(m.ref)]);
    return {
      meetingId: id,
      language: m.data.language ?? "vi-VN",
      diarized: Boolean(m.data.diarized),
      speakers: Object.entries(speakers).map(([speakerId, name]) => ({ id: speakerId, name })),
      lines,
    };
  });

  app.patch("/meetings/:id/speakers/:speakerId", { preHandler: requireAuth() }, async (req) => {
    const { id, speakerId } = req.params as { id: string; speakerId: string };
    const body = parse(speakerBody, req.body);
    const m = await loadMeeting(id, req.uid, true);
    const ref = m.ref.collection("speakers").doc(speakerId);
    if (!(await ref.get()).exists) throw notFound();
    await ref.update({ name: body.name });
    return { id: speakerId, name: body.name };
  });
}

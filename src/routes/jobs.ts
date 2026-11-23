import type { FastifyInstance } from "fastify";
import { db } from "../firebase.js";
import { requireAuth } from "../auth.js";
import { notFound } from "../errors.js";
import { iso } from "../util.js";

export async function jobRoutes(app: FastifyInstance) {
  app.get("/jobs/:jobId", { preHandler: requireAuth() }, async (req) => {
    const { jobId } = req.params as { jobId: string };
    const snap = await db.collection("jobs").doc(jobId).get();
    const d = snap.data();
    if (!d || d.ownerId !== req.uid) throw notFound();
    return {
      jobId,
      type: d.type,
      meetingId: d.meetingId,
      status: d.status, // queued | running | succeeded | failed
      error: d.error ?? null,
      createdAt: iso(d.createdAt),
      updatedAt: iso(d.updatedAt),
    };
  });
}

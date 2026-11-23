import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import type { DocumentData } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { requireAuth } from "../auth.js";
import { notFound } from "../errors.js";
import { iso, loadMeeting, parse } from "../util.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày dạng YYYY-MM-DD");
const createBody = z.object({
  title: z.string().trim().min(1, "Tiêu đề không được trống").max(300),
  assignee: z.string().trim().max(80).nullable().optional(),
  dueDate: date.nullable().optional(),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
});
const patchBody = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  assignee: z.string().trim().max(80).nullable().optional(),
  dueDate: date.nullable().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  status: z.enum(["todo", "in_progress", "done"]).optional(),
});

function serialize(id: string, d: DocumentData) {
  return {
    id,
    meetingId: d.meetingId,
    title: d.title,
    assignee: d.assignee ?? null,
    dueDate: d.dueDate ?? null,
    priority: d.priority ?? "medium",
    status: d.status ?? "todo",
    source: d.source ?? "manual",
    sourceStartMs: d.sourceStartMs ?? null,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
}

export async function actionItemRoutes(app: FastifyInstance) {
  app.get("/meetings/:id/action-items", { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    await loadMeeting(id, req.uid);
    const snap = await db.collection("actionItems").where("meetingId", "==", id).get();
    const items = snap.docs
      .map((d) => serialize(d.id, d.data()))
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    return { items, nextCursor: null };
  });

  app.post("/meetings/:id/action-items", { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(createBody, req.body);
    await loadMeeting(id, req.uid, true);
    const ref = db.collection("actionItems").doc();
    await ref.set({
      meetingId: id,
      title: body.title,
      assignee: body.assignee ?? null,
      dueDate: body.dueDate ?? null,
      priority: body.priority,
      status: "todo",
      source: "manual",
      sourceStartMs: null,
      editedByUser: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return reply.code(201).send(serialize(ref.id, (await ref.get()).data() ?? {}));
  });

  app.patch("/action-items/:itemId", { preHandler: requireAuth() }, async (req) => {
    const { itemId } = req.params as { itemId: string };
    const body = parse(patchBody, req.body);
    const ref = db.collection("actionItems").doc(itemId);
    const snap = await ref.get();
    if (!snap.exists) throw notFound();
    await loadMeeting(String(snap.data()?.meetingId), req.uid); // thành viên được sửa trạng thái
    const update: Record<string, unknown> = { editedByUser: true, updatedAt: FieldValue.serverTimestamp() };
    for (const key of ["title", "assignee", "dueDate", "priority", "status"] as const) {
      if (body[key] !== undefined) update[key] = body[key];
    }
    await ref.update(update);
    return serialize(itemId, (await ref.get()).data() ?? {});
  });

  app.delete("/action-items/:itemId", { preHandler: requireAuth() }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const ref = db.collection("actionItems").doc(itemId);
    const snap = await ref.get();
    if (!snap.exists) throw notFound();
    await loadMeeting(String(snap.data()?.meetingId), req.uid);
    await ref.delete();
    return reply.code(204).send();
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { requireAuth } from "../auth.js";
import { AppError } from "../errors.js";
import {
  decodeCursor,
  encodeCursor,
  loadMeeting,
  parse,
  serializeMeeting,
  type LoadedMeeting,
} from "../util.js";
import { deletePrefix } from "../services/storage.js";

const STATUSES = ["created", "recording", "uploading", "processing", "ready", "failed"] as const;
const tags = z.array(z.string().trim().min(1).max(30)).max(10);

const createBody = z.object({
  title: z.string().trim().min(1, "Tiêu đề không được trống").max(120),
  description: z.string().trim().max(2000).optional(),
  folderId: z.string().nullable().optional(),
  tags: tags.optional(),
  language: z.enum(["vi-VN", "en-US"]).default("vi-VN"),
  consent: z.object({ accepted: z.boolean() }).default({ accepted: false }),
});
const patchBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  folderId: z.string().nullable().optional(),
  tags: tags.optional(),
});
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
  folderId: z.string().optional(),
  tag: z.string().optional(),
  status: z.enum(STATUSES).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export async function meetingRoutes(app: FastifyInstance) {
  app.post("/meetings", { preHandler: requireAuth() }, async (req, reply) => {
    const body = parse(createBody, req.body);
    const ref = db.collection("meetings").doc();
    await ref.set({
      ownerId: req.uid,
      // memberIds có từ đầu để sau này mời thành viên mà không phải đổi mô hình dữ liệu.
      memberIds: [req.uid],
      title: body.title,
      description: body.description ?? null,
      folderId: body.folderId ?? null,
      tags: body.tags ?? [],
      language: body.language,
      status: "created",
      audioPath: null,
      durationMs: null,
      consent: body.consent.accepted
        ? { accepted: true, acceptedAt: FieldValue.serverTimestamp(), by: req.uid }
        : { accepted: false },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    const loaded = await loadMeeting(ref.id, req.uid);
    return reply.code(201).send(serializeMeeting(loaded));
  });

  // Cần chỉ mục composite (memberIds array-contains + createdAt desc): xem firebase/firestore.indexes.json.
  // Các bộ lọc phụ áp dụng trong bộ nhớ trên từng trang 50 bản ghi (tối đa 5 vòng) cho gọn index.
  app.get("/meetings", { preHandler: requireAuth() }, async (req) => {
    const q = parse(listQuery, req.query);
    const cursor = decodeCursor<{ t: number }>(q.cursor);
    const fromMs = q.from ? Date.parse(q.from) : null;
    const toMs = q.to ? Date.parse(q.to) : null;

    const items: LoadedMeeting[] = [];
    let last: number | null = cursor?.t ?? null;
    let exhausted = false;

    for (let round = 0; round < 5 && items.length < q.limit && !exhausted; round++) {
      let query = db
        .collection("meetings")
        .where("memberIds", "array-contains", req.uid)
        .orderBy("createdAt", "desc")
        .limit(50);
      if (last !== null) query = query.startAfter(Timestamp.fromMillis(last));
      const snap = await query.get();
      if (snap.size < 50) exhausted = true;
      for (const d of snap.docs) {
        const data = d.data();
        const created: number = (data.createdAt as Timestamp).toMillis();
        last = created;
        if (q.folderId && data.folderId !== q.folderId) continue;
        if (q.tag && !(data.tags ?? []).includes(q.tag)) continue;
        if (q.status && data.status !== q.status) continue;
        if (fromMs !== null && created < fromMs) continue;
        if (toMs !== null && created > toMs) continue;
        items.push({ id: d.id, ref: d.ref, data });
        if (items.length >= q.limit) break;
      }
    }
    const more = !exhausted || items.length >= q.limit;
    return {
      items: items.map(serializeMeeting),
      nextCursor: more && last !== null ? encodeCursor({ t: last }) : null,
    };
  });

  app.get("/meetings/:id", { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    return serializeMeeting(await loadMeeting(id, req.uid));
  });

  app.patch("/meetings/:id", { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(patchBody, req.body);
    const m = await loadMeeting(id, req.uid, true);
    const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    for (const key of ["title", "description", "folderId", "tags"] as const) {
      if (body[key] !== undefined) update[key] = body[key];
    }
    await m.ref.update(update);
    return serializeMeeting(await loadMeeting(id, req.uid));
  });

  app.delete("/meetings/:id", { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const m = await loadMeeting(id, req.uid, true);
    if (m.data.status === "processing") {
      throw new AppError(409, "JOB_IN_PROGRESS", "Cuộc họp đang được xử lý");
    }
    const [actions, jobs] = await Promise.all([
      db.collection("actionItems").where("meetingId", "==", id).get(),
      db.collection("jobs").where("meetingId", "==", id).get(),
    ]);
    await Promise.all([...actions.docs, ...jobs.docs].map((d) => d.ref.delete()));
    await db.recursiveDelete(m.ref);
    await deletePrefix(`audio/${m.data.ownerId}/${id}/`);
    return reply.code(204).send();
  });
}

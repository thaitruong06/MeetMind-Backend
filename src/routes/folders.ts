import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import type { DocumentData } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { requireAuth } from "../auth.js";
import { notFound } from "../errors.js";
import { iso, parse } from "../util.js";

const createBody = z.object({
  name: z.string().trim().min(1, "Tên thư mục không được trống").max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Màu dạng #RRGGBB").optional(),
});
const patchBody = createBody.partial();

function serialize(id: string, d: DocumentData) {
  return { id, name: d.name ?? "", color: d.color ?? null, createdAt: iso(d.createdAt) };
}

export async function folderRoutes(app: FastifyInstance) {
  const col = (uid: string) => db.collection("users").doc(uid).collection("folders");

  app.get("/folders", { preHandler: requireAuth() }, async (req) => {
    const snap = await col(req.uid).orderBy("createdAt", "asc").get();
    return { items: snap.docs.map((d) => serialize(d.id, d.data())), nextCursor: null };
  });

  app.post("/folders", { preHandler: requireAuth() }, async (req, reply) => {
    const body = parse(createBody, req.body);
    const ref = col(req.uid).doc();
    await ref.set({ name: body.name, color: body.color ?? null, createdAt: FieldValue.serverTimestamp() });
    return reply.code(201).send(serialize(ref.id, (await ref.get()).data() ?? {}));
  });

  app.patch("/folders/:id", { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(patchBody, req.body);
    const ref = col(req.uid).doc(id);
    if (!(await ref.get()).exists) throw notFound();
    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.color !== undefined) update.color = body.color;
    if (Object.keys(update).length) await ref.update(update);
    return serialize(id, (await ref.get()).data() ?? {});
  });

  app.delete("/folders/:id", { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ref = col(req.uid).doc(id);
    if (!(await ref.get()).exists) throw notFound();
    // Cuộc họp trong thư mục này về "không thư mục".
    const meetings = await db.collection("meetings").where("ownerId", "==", req.uid).where("folderId", "==", id).get();
    await Promise.all(meetings.docs.map((m) => m.ref.update({ folderId: null })));
    await ref.delete();
    return reply.code(204).send();
  });
}

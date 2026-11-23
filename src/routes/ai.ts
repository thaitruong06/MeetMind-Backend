import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { notFound } from "../errors.js";
import { iso, loadMeeting } from "../util.js";
import { enqueueJob } from "../services/jobs.js";
import { generateJson } from "../services/gemini.js";
import { transcriptAsText } from "../services/transcript.js";
import { ACTION_ITEMS_SYSTEM, MINDMAP_SYSTEM, SUMMARY_SYSTEM } from "../services/prompts.js";

// Hạn mức riêng cho endpoint tốn Gemini (free tier có giới hạn request/phút).
const aiLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

const summarySchema = z.object({
  overview: z.string(),
  keyPoints: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
});

const actionItemsSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().min(1),
        assignee: z.string().nullable().default(null),
        dueDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .default(null),
        priority: z.enum(["low", "medium", "high"]).default("medium"),
        sourceStartMs: z.number().nullable().default(null),
      }),
    )
    .max(50),
});

interface RawNode {
  label: string;
  children?: RawNode[];
}
const nodeSchema: z.ZodType<RawNode> = z.lazy(() =>
  z.object({ label: z.string().min(1), children: z.array(nodeSchema).optional() }),
);

interface MindNode {
  id: string;
  label: string;
  children: MindNode[];
}
/** Gán id ổn định, giới hạn độ sâu 4 và tổng 60 nút để Android vẽ mượt. */
function withIds(node: RawNode, budget = { left: 60 }, depth = 0, path = "n"): MindNode {
  budget.left--;
  const children: MindNode[] = [];
  if (depth < 4) {
    for (const [i, c] of (node.children ?? []).entries()) {
      if (budget.left <= 0) break;
      children.push(withIds(c, budget, depth + 1, `${path}.${i}`));
    }
  }
  return { id: path, label: node.label, children };
}

export async function aiRoutes(app: FastifyInstance) {
  // ---- Summary ----
  app.post("/meetings/:id/summary", { preHandler: requireAuth(), config: aiLimit }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const m = await loadMeeting(id, req.uid, true);
    await transcriptAsText(m.ref); // báo 409 TRANSCRIPT_NOT_READY sớm nếu chưa có transcript
    const jobId = await enqueueJob({
      type: "summary",
      meetingId: id,
      ownerId: req.uid,
      run: async () => {
        const text = await transcriptAsText(m.ref);
        const out = await generateJson(SUMMARY_SYSTEM, `Transcript:\n${text}`, summarySchema);
        await m.ref.collection("outputs").doc("summary").set({
          ...out,
          model: config.GEMINI_MODEL,
          createdAt: FieldValue.serverTimestamp(),
        });
      },
    });
    return reply.code(202).send({ jobId });
  });

  app.get("/meetings/:id/summary", { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    const m = await loadMeeting(id, req.uid);
    const snap = await m.ref.collection("outputs").doc("summary").get();
    if (!snap.exists) throw notFound();
    const d = snap.data() ?? {};
    return { meetingId: id, ...d, createdAt: iso(d.createdAt) };
  });

  // ---- Action items (AI) ----
  app.post(
    "/meetings/:id/action-items/extract",
    { preHandler: requireAuth(), config: aiLimit },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const m = await loadMeeting(id, req.uid, true);
      await transcriptAsText(m.ref);
      const jobId = await enqueueJob({
        type: "action_items",
        meetingId: id,
        ownerId: req.uid,
        run: async () => {
          const text = await transcriptAsText(m.ref);
          const out = await generateJson(ACTION_ITEMS_SYSTEM, `Transcript:\n${text}`, actionItemsSchema);
          // Thay các việc do AI tạo lần trước, giữ nguyên việc người dùng thêm tay hoặc đã sửa.
          const old = await db
            .collection("actionItems")
            .where("meetingId", "==", id)
            .where("source", "==", "ai")
            .get();
          const batch = db.batch();
          old.docs.filter((d) => !d.data().editedByUser).forEach((d) => batch.delete(d.ref));
          for (const it of out.items) {
            batch.set(db.collection("actionItems").doc(), {
              meetingId: id,
              title: it.title,
              assignee: it.assignee, // chưa nêu thì null: UI hiện "chưa xác định"
              dueDate: it.dueDate,
              priority: it.priority,
              status: "todo",
              source: "ai",
              sourceStartMs: it.sourceStartMs,
              editedByUser: false,
              createdAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            });
          }
          await batch.commit();
        },
      });
      return reply.code(202).send({ jobId });
    },
  );

  // ---- Mindmap ----
  app.post("/meetings/:id/mindmap", { preHandler: requireAuth(), config: aiLimit }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const m = await loadMeeting(id, req.uid, true);
    await transcriptAsText(m.ref);
    const jobId = await enqueueJob({
      type: "mindmap",
      meetingId: id,
      ownerId: req.uid,
      run: async () => {
        const text = await transcriptAsText(m.ref);
        const raw = await generateJson(MINDMAP_SYSTEM, `Transcript:\n${text}`, nodeSchema);
        await m.ref.collection("outputs").doc("mindmap").set({
          root: withIds(raw),
          model: config.GEMINI_MODEL,
          createdAt: FieldValue.serverTimestamp(),
        });
      },
    });
    return reply.code(202).send({ jobId });
  });

  app.get("/meetings/:id/mindmap", { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    const m = await loadMeeting(id, req.uid);
    const snap = await m.ref.collection("outputs").doc("mindmap").get();
    if (!snap.exists) throw notFound();
    const d = snap.data() ?? {};
    return { meetingId: id, root: d.root, createdAt: iso(d.createdAt) };
  });
}

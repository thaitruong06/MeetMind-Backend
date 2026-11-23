import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import type { DocumentData } from "firebase-admin/firestore";
import { auth, db } from "../firebase.js";
import { requireAuth } from "../auth.js";
import { AppError, notFound } from "../errors.js";
import { iso, parse } from "../util.js";
import { MAX_AVATAR_BYTES } from "../config.js";
import { deletePrefix, fileInfo, signedReadUrl, signedUploadUrl } from "../services/storage.js";

/**
 * Tên hiển thị: chuẩn hóa Unicode NFC (giữ dấu tiếng Việt), cho phép chữ cái mọi ngôn ngữ, dấu, khoảng trắng, ' . -
 * Ví dụ hợp lệ: "Nguyễn Thị Ánh Tuyết", "Đỗ Văn Hưng".
 */
const displayName = z
  .string()
  .transform((s) => s.normalize("NFC").trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1, "Tên không được để trống")
      .max(60, "Tên tối đa 60 ký tự")
      .regex(/^[\p{L}\p{M}][\p{L}\p{M}\s'.-]*$/u, "Tên chỉ gồm chữ cái, khoảng trắng, dấu ' . -"),
  );

const createBody = z.object({ displayName: displayName.optional() }).default({});
const patchBody = z
  .object({ displayName: displayName.optional(), language: z.enum(["vi-VN", "en-US"]).optional() })
  .refine((v) => v.displayName !== undefined || v.language !== undefined, "Không có trường nào để sửa");
const avatarBody = z.object({
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  sizeBytes: z.number().int().positive().optional(),
});

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

async function serialize(uid: string, data: DocumentData) {
  let avatarUrl: string | null = null;
  if (data.avatarPath) {
    const info = await fileInfo(data.avatarPath);
    if (info.exists) avatarUrl = (await signedReadUrl(data.avatarPath, 60)).url;
  }
  return {
    uid,
    email: data.email ?? "",
    displayName: data.displayName ?? "",
    language: data.language ?? "vi-VN",
    avatarUrl,
    createdAt: iso(data.createdAt),
  };
}

export async function userRoutes(app: FastifyInstance) {
  // Gọi ngay sau đăng ký (email có thể chưa xác thực). Idempotent: có rồi thì trả 200.
  app.post("/users/me", { preHandler: requireAuth({ allowUnverified: true }) }, async (req, reply) => {
    const body = parse(createBody, req.body ?? {});
    const ref = db.collection("users").doc(req.uid);
    const snap = await ref.get();
    if (snap.exists) return reply.code(200).send(await serialize(req.uid, snap.data() ?? {}));

    const user = await auth.getUser(req.uid);
    const name = body.displayName ?? user.displayName ?? req.userEmail.split("@")[0] ?? "";
    await ref.set({
      email: req.userEmail,
      displayName: name,
      language: "vi-VN",
      avatarPath: null,
      createdAt: FieldValue.serverTimestamp(),
    });
    const created = await ref.get();
    return reply.code(201).send(await serialize(req.uid, created.data() ?? {}));
  });

  app.get("/users/me", { preHandler: requireAuth() }, async (req) => {
    const snap = await db.collection("users").doc(req.uid).get();
    if (!snap.exists) throw notFound();
    return serialize(req.uid, snap.data() ?? {});
  });

  app.patch("/users/me", { preHandler: requireAuth() }, async (req) => {
    const body = parse(patchBody, req.body);
    const ref = db.collection("users").doc(req.uid);
    if (!(await ref.get()).exists) throw notFound();
    const update: Record<string, unknown> = {};
    if (body.displayName !== undefined) update.displayName = body.displayName;
    if (body.language !== undefined) update.language = body.language;
    await ref.update(update);
    if (body.displayName !== undefined) await auth.updateUser(req.uid, { displayName: body.displayName });
    return serialize(req.uid, (await ref.get()).data() ?? {});
  });

  // Xin signed URL tải ảnh đại diện lên. Sau khi PUT xong, GET /users/me trả avatarUrl (signed, 1 giờ).
  app.post("/users/me/avatar", { preHandler: requireAuth() }, async (req) => {
    const body = parse(avatarBody, req.body);
    if (body.sizeBytes && body.sizeBytes > MAX_AVATAR_BYTES) {
      throw new AppError(413, "FILE_TOO_LARGE", "Ảnh tối đa 2 MB");
    }
    const path = `avatars/${req.uid}/avatar-${Date.now()}.${EXT[body.contentType]}`;
    const signed = await signedUploadUrl(path, body.contentType);
    await db.collection("users").doc(req.uid).update({ avatarPath: path });
    return {
      uploadUrl: signed.url,
      method: "PUT",
      headers: { "Content-Type": body.contentType },
      expiresAt: signed.expiresAt,
    };
  });

  // Xóa tài khoản và toàn bộ dữ liệu: meetings do người này sở hữu, thư mục, file GCS, rồi tài khoản Auth.
  app.delete("/users/me", { preHandler: requireAuth() }, async (req, reply) => {
    const uid = req.uid;
    const owned = await db.collection("meetings").where("ownerId", "==", uid).get();
    for (const m of owned.docs) {
      const actions = await db.collection("actionItems").where("meetingId", "==", m.id).get();
      await Promise.all(actions.docs.map((a) => a.ref.delete()));
      const jobs = await db.collection("jobs").where("meetingId", "==", m.id).get();
      await Promise.all(jobs.docs.map((j) => j.ref.delete()));
      await db.recursiveDelete(m.ref);
    }
    await db.recursiveDelete(db.collection("users").doc(uid));
    await deletePrefix(`audio/${uid}/`);
    await deletePrefix(`avatars/${uid}/`);
    await auth.deleteUser(uid);
    return reply.code(204).send();
  });
}

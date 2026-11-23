import type { z } from "zod";
import type { DocumentData, DocumentReference, Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase.js";
import { AppError, forbidden, notFound, validation } from "./errors.js";

/** Kiểm tra dữ liệu vào bằng zod; lỗi -> 422 VALIDATION_FAILED kèm field. */
export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw validation(issue?.message ?? "Dữ liệu không hợp lệ", issue?.path.join(".") || undefined);
  }
  return result.data;
}

export function iso(value: unknown): string | null {
  const ts = value as Timestamp | undefined;
  return ts && typeof ts.toDate === "function" ? ts.toDate().toISOString() : null;
}

export interface LoadedMeeting {
  id: string;
  ref: DocumentReference;
  data: DocumentData;
}

/**
 * Lấy cuộc họp mà người dùng có quyền xem.
 * Không phải thành viên -> 404 (không lộ sự tồn tại). ownerOnly -> 403 nếu là thành viên nhưng không phải chủ.
 */
export async function loadMeeting(id: string, uid: string, ownerOnly = false): Promise<LoadedMeeting> {
  const ref = db.collection("meetings").doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw notFound();
  const data = snap.data() ?? {};
  const members: string[] = Array.isArray(data.memberIds) ? data.memberIds : [];
  if (data.ownerId !== uid && !members.includes(uid)) throw notFound();
  if (ownerOnly && data.ownerId !== uid) throw forbidden();
  return { id: snap.id, ref, data };
}

export function serializeMeeting(m: LoadedMeeting) {
  const d = m.data;
  return {
    id: m.id,
    title: d.title ?? "",
    description: d.description ?? null,
    folderId: d.folderId ?? null,
    tags: d.tags ?? [],
    status: d.status ?? "created",
    language: d.language ?? "vi-VN",
    durationMs: d.durationMs ?? null,
    ownerId: d.ownerId,
    hasAudio: Boolean(d.audioPath),
    consentAccepted: Boolean(d.consent?.accepted),
    lastJobId: d.lastJobId ?? null,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
}

export function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor<T>(cursor: string | undefined): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as T;
  } catch {
    throw new AppError(422, "VALIDATION_FAILED", "cursor không hợp lệ", "cursor");
  }
}

export function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

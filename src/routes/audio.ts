import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import { requireAuth } from "../auth.js";
import { AppError } from "../errors.js";
import { loadMeeting, parse, type LoadedMeeting } from "../util.js";
import { MAX_AUDIO_BYTES } from "../config.js";
import { deleteFile, fileInfo, signedReadUrl, signedUploadUrl } from "../services/storage.js";
import { enqueueJob } from "../services/jobs.js";
import { transcribeMeeting } from "../services/transcribe.js";

const audioBody = z.object({
  contentType: z.enum(["audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac", "audio/mpeg", "audio/wav"]).default("audio/mp4"),
  sizeBytes: z.number().int().positive().optional(),
});
const transcriptionBody = z
  .object({
    language: z.enum(["vi-VN", "en-US"]).optional(),
    diarization: z.boolean().default(true),
    speakerCount: z.number().int().min(1).max(10).optional(),
  })
  .default({ diarization: true });

function startTranscription(
  m: LoadedMeeting,
  ownerId: string,
  opts: { language: string; diarization: boolean; speakerCount?: number },
) {
  const audioPath = String(m.data.audioPath);
  return enqueueJob({
    type: "transcription",
    meetingId: m.id,
    ownerId,
    run: () => transcribeMeeting(m.id, ownerId, audioPath, opts),
  });
}

export async function audioRoutes(app: FastifyInstance) {
  // Bước 1: xin signed URL. Phải có consent ghi âm (409 CONSENT_REQUIRED).
  app.post("/meetings/:id/audio", { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(audioBody, req.body ?? {});
    const m = await loadMeeting(id, req.uid, true);
    if (!m.data.consent?.accepted) {
      throw new AppError(409, "CONSENT_REQUIRED", "Chưa xác nhận đồng ý ghi âm");
    }
    if (body.sizeBytes && body.sizeBytes > MAX_AUDIO_BYTES) {
      throw new AppError(413, "FILE_TOO_LARGE", "File âm thanh vượt giới hạn");
    }
    const path = `audio/${m.data.ownerId}/${id}/original`;
    const signed = await signedUploadUrl(path, body.contentType);
    await m.ref.update({ status: "uploading", audioPath: path, updatedAt: FieldValue.serverTimestamp() });
    return {
      uploadUrl: signed.url,
      method: "PUT",
      headers: { "Content-Type": body.contentType },
      expiresAt: signed.expiresAt,
    };
  });

  // Bước 2: Android PUT file lên uploadUrl rồi gọi complete -> backend kiểm tra file và bắt đầu phiên âm.
  app.post("/meetings/:id/audio/complete", { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const m = await loadMeeting(id, req.uid, true);
    const path = m.data.audioPath as string | null;
    if (!path) throw new AppError(422, "VALIDATION_FAILED", "Chưa xin URL upload", "audio");
    const info = await fileInfo(path);
    if (!info.exists) throw new AppError(422, "VALIDATION_FAILED", "Chưa thấy file đã upload", "audio");
    if (info.size > MAX_AUDIO_BYTES) {
      await deleteFile(path);
      await m.ref.update({ audioPath: null, status: "created" });
      throw new AppError(413, "FILE_TOO_LARGE", "File âm thanh vượt giới hạn");
    }
    const jobId = await startTranscription(m, req.uid, {
      language: String(m.data.language ?? "vi-VN"),
      diarization: true,
    });
    return reply.code(202).send({ jobId });
  });

  app.get("/meetings/:id/audio", { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    const m = await loadMeeting(id, req.uid);
    if (!m.data.audioPath) throw new AppError(404, "NOT_FOUND", "Cuộc họp chưa có âm thanh");
    return signedReadUrl(String(m.data.audioPath), 60);
  });

  // Chạy lại phiên âm (đổi ngôn ngữ, bật/tắt diarization).
  app.post("/meetings/:id/transcription", { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(transcriptionBody, req.body ?? {});
    const m = await loadMeeting(id, req.uid, true);
    if (!m.data.audioPath) throw new AppError(422, "VALIDATION_FAILED", "Cuộc họp chưa có âm thanh", "audio");
    const language = body.language ?? String(m.data.language ?? "vi-VN");
    const jobId = await startTranscription(m, req.uid, {
      language,
      diarization: body.diarization,
      speakerCount: body.speakerCount,
    });
    return reply.code(202).send({ jobId });
  });
}

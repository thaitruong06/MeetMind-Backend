import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { AppError } from "../errors.js";

export type JobType = "transcription" | "summary" | "action_items" | "mindmap";

const STALE_MS = 30 * 60_000;

/**
 * Hàng đợi tối giản: job lưu ở Firestore (jobs/{id}), chạy nền trong tiến trình.
 * Cloud Run phải bật --no-cpu-throttling để việc nền không bị đóng băng sau khi trả response.
 * Khi cần ổn định hơn: thay `setImmediate` bằng Cloud Tasks gọi POST /internal/jobs/run (cùng cấu trúc job).
 */
export async function enqueueJob(opts: {
  type: JobType;
  meetingId: string;
  ownerId: string;
  run: () => Promise<void>;
}): Promise<string> {
  const existing = await db.collection("jobs").where("meetingId", "==", opts.meetingId).get();
  const busy = existing.docs.some((d) => {
    const j = d.data();
    const created: number = j.createdAt?.toMillis?.() ?? 0;
    return (
      j.type === opts.type &&
      (j.status === "queued" || j.status === "running") &&
      Date.now() - created < STALE_MS
    );
  });
  if (busy) throw new AppError(409, "JOB_IN_PROGRESS", "Đang có tác vụ cùng loại cho cuộc họp này");

  const ref = db.collection("jobs").doc();
  await ref.set({
    type: opts.type,
    meetingId: opts.meetingId,
    ownerId: opts.ownerId,
    status: "queued",
    error: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await db.collection("meetings").doc(opts.meetingId).update({ lastJobId: ref.id });

  setImmediate(() => {
    void execute(ref.id, opts.meetingId, opts.type, opts.run);
  });
  return ref.id;
}

async function execute(jobId: string, meetingId: string, type: JobType, run: () => Promise<void>) {
  const ref = db.collection("jobs").doc(jobId);
  await ref.update({ status: "running", updatedAt: FieldValue.serverTimestamp() });
  try {
    await run();
    await ref.update({ status: "succeeded", updatedAt: FieldValue.serverTimestamp() });
  } catch (e) {
    const code = e instanceof AppError ? e.code : "INTERNAL";
    // Không ghi nội dung transcript/prompt vào log hay lỗi, chỉ mã và thông điệp ngắn.
    const message = e instanceof AppError ? e.message : "Lỗi không lường trước";
    console.error(JSON.stringify({ msg: "job_failed", jobId, type, code }));
    await ref.update({
      status: "failed",
      error: { code, message },
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (type === "transcription") {
      await db.collection("meetings").doc(meetingId).update({ status: "failed" });
    }
  }
}

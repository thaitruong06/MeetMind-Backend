import type { DocumentReference } from "firebase-admin/firestore";
import { AppError } from "../errors.js";
import { formatTime } from "../util.js";

export interface TranscriptLine {
  id: string;
  startMs: number;
  endMs: number;
  speakerId: string;
  text: string;
}

const MAX_CHARS = 400_000;

export async function loadSpeakers(meetingRef: DocumentReference): Promise<Record<string, string>> {
  const snap = await meetingRef.collection("speakers").get();
  const map: Record<string, string> = {};
  snap.docs.forEach((d) => (map[d.id] = String(d.data().name ?? d.id)));
  return map;
}

export async function loadLines(meetingRef: DocumentReference): Promise<TranscriptLine[]> {
  const snap = await meetingRef.collection("transcriptLines").orderBy("index").get();
  return snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id,
      startMs: Number(x.startMs ?? 0),
      endMs: Number(x.endMs ?? 0),
      speakerId: String(x.speakerId ?? "spk_1"),
      text: String(x.text ?? ""),
    };
  });
}

/** Văn bản đưa vào prompt: "[mm:ss] Tên người nói: nội dung". Báo lỗi nếu chưa có transcript. */
export async function transcriptAsText(meetingRef: DocumentReference): Promise<string> {
  const [lines, speakers] = await Promise.all([loadLines(meetingRef), loadSpeakers(meetingRef)]);
  if (lines.length === 0) {
    throw new AppError(409, "TRANSCRIPT_NOT_READY", "Cuộc họp chưa có transcript");
  }
  let text = lines
    .map((l) => `[${formatTime(l.startMs)}] ${speakers[l.speakerId] ?? l.speakerId}: ${l.text}`)
    .join("\n");
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
  return text;
}

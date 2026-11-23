import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpeechClient } from "@google-cloud/speech";
import { FieldValue } from "firebase-admin/firestore";
import { bucket, db } from "../firebase.js";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { deleteFile } from "./storage.js";

/**
 * Pipeline batch: M4A (GCS) -> ffmpeg -> FLAC mono 16 kHz (GCS) -> Speech-to-Text V1 longRunningRecognize
 * -> ghi transcriptLines + speakers vào Firestore.
 * Muốn đổi sang V2/Chirp hay lấy transcript từ Vexa: chỉ cần thay hàm `recognize`, phần còn lại giữ nguyên.
 */
export interface TranscribeOptions {
  language: string;
  diarization: boolean;
  speakerCount?: number;
}

interface Line {
  startMs: number;
  endMs: number;
  speakerId: string;
  text: string;
}

const speech = new SpeechClient();

function runFfmpeg(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", output]);
    let stderr = "";
    p.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-500)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr}`))));
  });
}

function toMs(t: unknown): number {
  const x = t as { seconds?: number | string | { toString(): string }; nanos?: number } | null | undefined;
  if (!x) return 0;
  return Number(x.seconds ?? 0) * 1000 + Math.round(Number(x.nanos ?? 0) / 1e6);
}

async function recognize(gcsUri: string, opts: TranscribeOptions, diarize: boolean) {
  const [operation] = await speech.longRunningRecognize({
    config: {
      encoding: "FLAC",
      languageCode: opts.language,
      enableWordTimeOffsets: true,
      enableAutomaticPunctuation: true,
      ...(diarize
        ? {
            diarizationConfig: {
              enableSpeakerDiarization: true,
              minSpeakerCount: 1,
              maxSpeakerCount: opts.speakerCount ?? 6,
            },
          }
        : {}),
    },
    audio: { uri: gcsUri },
  });
  const [response] = await operation.promise();
  return response;
}

type Word = { word?: string | null; startTime?: unknown; endTime?: unknown; speakerTag?: number | null };

function buildLines(response: Awaited<ReturnType<typeof recognize>>, diarize: boolean): Line[] {
  const results = response.results ?? [];
  const lines: Line[] = [];

  if (diarize && results.length > 0) {
    // Với diarization, từ có speakerTag nằm đầy đủ ở alternative cuối cùng.
    const words = (results[results.length - 1].alternatives?.[0]?.words ?? []) as Word[];
    let cur: Line | null = null;
    let count = 0;
    for (const w of words) {
      const tag = w.speakerTag && w.speakerTag > 0 ? w.speakerTag : 1;
      const speakerId = `spk_${tag}`;
      const start = toMs(w.startTime);
      const end = toMs(w.endTime);
      const gap = cur ? start - cur.endMs : 0;
      if (!cur || cur.speakerId !== speakerId || gap > 2500 || count >= 60) {
        if (cur) lines.push(cur);
        cur = { startMs: start, endMs: end, speakerId, text: w.word ?? "" };
        count = 1;
      } else {
        cur.text += ` ${w.word ?? ""}`;
        cur.endMs = end;
        count++;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  for (const r of results) {
    const alt = r.alternatives?.[0];
    if (!alt?.transcript) continue;
    const words = (alt.words ?? []) as Word[];
    lines.push({
      startMs: words.length ? toMs(words[0].startTime) : 0,
      endMs: words.length ? toMs(words[words.length - 1].endTime) : 0,
      speakerId: "spk_1",
      text: alt.transcript.trim(),
    });
  }
  return lines;
}

async function replaceTranscript(meetingId: string, lines: Line[], language: string, diarized: boolean) {
  const meetingRef = db.collection("meetings").doc(meetingId);
  await db.recursiveDelete(meetingRef.collection("transcriptLines"));
  await db.recursiveDelete(meetingRef.collection("speakers"));

  const speakerIds = [...new Set(lines.map((l) => l.speakerId))];
  for (let i = 0; i < lines.length; i += 400) {
    const batch = db.batch();
    lines.slice(i, i + 400).forEach((l, j) => {
      const id = String(i + j).padStart(6, "0");
      batch.set(meetingRef.collection("transcriptLines").doc(id), { ...l, index: i + j });
    });
    await batch.commit();
  }
  const sb = db.batch();
  speakerIds.forEach((id, idx) => {
    sb.set(meetingRef.collection("speakers").doc(id), { name: `Người nói ${idx + 1}` });
  });
  const durationMs = lines.length ? Math.max(...lines.map((l) => l.endMs)) : 0;
  sb.update(meetingRef, {
    status: "ready",
    language,
    diarized,
    durationMs,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await sb.commit();
}

export async function transcribeMeeting(meetingId: string, ownerId: string, audioPath: string, opts: TranscribeOptions) {
  const meetingRef = db.collection("meetings").doc(meetingId);
  await meetingRef.update({ status: "processing" });

  const dir = await mkdtemp(join(tmpdir(), "mm-"));
  const flacPath = `audio/${ownerId}/${meetingId}/processed.flac`;
  try {
    const original = join(dir, "original");
    const flac = join(dir, "out.flac");
    await bucket.file(audioPath).download({ destination: original });
    await runFfmpeg(original, flac).catch(() => {
      throw new AppError(422, "AUDIO_UNREADABLE", "Không đọc được file âm thanh");
    });
    await bucket.upload(flac, { destination: flacPath });

    const uri = `gs://${config.STORAGE_BUCKET}/${flacPath}`;
    let diarized = opts.diarization;
    let response;
    try {
      response = await recognize(uri, opts, diarized);
    } catch (e) {
      // Một số ngôn ngữ không hỗ trợ diarization: thử lại không diarization.
      if (diarized) {
        diarized = false;
        try {
          response = await recognize(uri, opts, false);
        } catch {
          throw new AppError(502, "AI_UPSTREAM_ERROR", "Speech-to-Text lỗi");
        }
      } else {
        throw new AppError(502, "AI_UPSTREAM_ERROR", "Speech-to-Text lỗi");
      }
    }

    const lines = buildLines(response, diarized);
    if (lines.length === 0) {
      throw new AppError(422, "TRANSCRIPT_EMPTY", "Không nhận diện được lời nói trong file");
    }
    await replaceTranscript(meetingId, lines, opts.language, diarized);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await deleteFile(flacPath).catch(() => undefined);
  }
}

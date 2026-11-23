import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { AppError } from "./errors.js";
import { config } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { userRoutes } from "./routes/users.js";
import { folderRoutes } from "./routes/folders.js";
import { meetingRoutes } from "./routes/meetings.js";
import { audioRoutes } from "./routes/audio.js";
import { transcriptRoutes } from "./routes/transcript.js";
import { aiRoutes } from "./routes/ai.js";
import { actionItemRoutes } from "./routes/actionItems.js";
import { chatRoutes } from "./routes/chat.js";
import { jobRoutes } from "./routes/jobs.js";

export async function buildApp() {
  const app = Fastify({
    trustProxy: true, // Cloud Run đứng sau proxy: lấy IP thật để giới hạn tần suất
    bodyLimit: 1_000_000,
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
      // Không log token hay nội dung nhạy cảm.
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    genReqId: () => crypto.randomUUID(),
  });

  app.decorateRequest("uid", "");
  app.decorateRequest("userEmail", "");

  await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });

  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    if (err instanceof AppError) {
      return reply.code(err.status).send({
        error: { code: err.code, message: err.message, field: err.field, requestId },
      });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode === 429) {
      return reply.code(429).send({
        error: { code: "RATE_LIMITED", message: "Quá nhiều yêu cầu, thử lại sau", requestId },
      });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({
        error: { code: "VALIDATION_FAILED", message: e.message ?? "Yêu cầu không hợp lệ", requestId },
      });
    }
    req.log.error({ err: { code: e.code, message: e.message } }, "unhandled_error");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Lỗi không lường trước", requestId } });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "Không tìm thấy", requestId: req.id } }),
  );

  await app.register(healthRoutes);
  await app.register(userRoutes);
  await app.register(folderRoutes);
  await app.register(meetingRoutes);
  await app.register(audioRoutes);
  await app.register(transcriptRoutes);
  await app.register(aiRoutes);
  await app.register(actionItemRoutes);
  await app.register(chatRoutes);
  await app.register(jobRoutes);
  return app;
}

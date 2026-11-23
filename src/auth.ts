import type { FastifyRequest } from "fastify";
import { auth } from "./firebase.js";
import { AppError } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    uid: string;
    userEmail: string;
  }
}

/**
 * Xác thực Firebase ID Token (Authorization: Bearer ...).
 * Mặc định yêu cầu email đã xác thực -> 403 EMAIL_NOT_VERIFIED.
 * Chỉ POST /users/me được phép allowUnverified (tạo hồ sơ ngay sau khi đăng ký).
 */
export function requireAuth(opts: { allowUnverified?: boolean } = {}) {
  return async (req: FastifyRequest): Promise<void> => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw new AppError(401, "UNAUTHENTICATED", "Thiếu token");
    }
    let decoded;
    try {
      decoded = await auth.verifyIdToken(header.slice(7));
    } catch {
      throw new AppError(401, "UNAUTHENTICATED", "Token không hợp lệ hoặc đã hết hạn");
    }
    if (!decoded.email_verified && !opts.allowUnverified) {
      throw new AppError(403, "EMAIL_NOT_VERIFIED", "Email chưa được xác thực");
    }
    req.uid = decoded.uid;
    req.userEmail = decoded.email ?? "";
  };
}

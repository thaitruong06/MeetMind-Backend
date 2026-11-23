/** Lỗi nghiệp vụ. Android chỉ dựa vào `code` (xem Phần 4.3 của kế hoạch). */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public field?: string,
  ) {
    super(message);
  }
}

export const notFound = () => new AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên");
export const forbidden = () => new AppError(403, "FORBIDDEN", "Không đủ quyền");
export const validation = (message: string, field?: string) =>
  new AppError(422, "VALIDATION_FAILED", message, field);

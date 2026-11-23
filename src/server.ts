import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = await buildApp();

// Cloud Run gửi SIGTERM khi tắt instance: đóng gọn để request đang chạy kịp hoàn tất.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: config.PORT, host: "0.0.0.0" });

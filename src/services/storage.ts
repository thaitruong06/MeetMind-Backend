import { bucket } from "../firebase.js";

/** Signed URL: client tải trực tiếp lên/xuống Cloud Storage, backend không giữ file qua RAM. */
export async function signedUploadUrl(path: string, contentType: string, minutes = 15) {
  const expires = Date.now() + minutes * 60_000;
  const [url] = await bucket.file(path).getSignedUrl({
    version: "v4",
    action: "write",
    expires,
    contentType,
  });
  return { url, expiresAt: new Date(expires).toISOString() };
}

export async function signedReadUrl(path: string, minutes = 60) {
  const expires = Date.now() + minutes * 60_000;
  const [url] = await bucket.file(path).getSignedUrl({ version: "v4", action: "read", expires });
  return { url, expiresAt: new Date(expires).toISOString() };
}

export async function fileInfo(path: string): Promise<{ exists: boolean; size: number }> {
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) return { exists: false, size: 0 };
  const [meta] = await file.getMetadata();
  return { exists: true, size: Number(meta.size ?? 0) };
}

export async function deleteFile(path: string): Promise<void> {
  await bucket.file(path).delete({ ignoreNotFound: true });
}

export async function deletePrefix(prefix: string): Promise<void> {
  await bucket.deleteFiles({ prefix, force: true });
}

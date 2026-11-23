# MeetMind-Backend

Backend của MeetMind (Node.js 22 + TypeScript + Fastify) chạy trên Cloud Run.
Firebase chỉ dùng **Authentication** và **Firestore**; file âm thanh/ảnh nằm ở **Google Cloud Storage** (signed URL).
Gemini và Speech-to-Text chỉ được gọi từ backend, khóa không bao giờ xuống app Android.

## 1. Tạo repo và đẩy code lên GitHub

```bash
# Giải nén zip, vào thư mục MeetMind-Backend
git init -b main
git add .
git commit -m "chore: scaffold MeetMind-Backend"

# Cách 1: GitHub CLI (repo private)
gh repo create MeetMind-Backend --private --source=. --remote=origin --push

# Cách 2: tạo repo rỗng trên github.com (không tick README/.gitignore), rồi:
git remote add origin https://github.com/<tai-khoan>/MeetMind-Backend.git
git push -u origin main
git checkout -b develop && git push -u origin develop
```

Sau đó vào **Settings → Collaborators** mời thành viên 1, và **Settings → Branches** bảo vệ `main` và `develop` (bắt buộc PR + CI xanh).
Không bao giờ commit `.env` hay file khóa service account (đã nằm trong `.gitignore`).

## 2. Chuẩn bị Google Cloud / Firebase (làm một lần)

Dùng **cùng project** với Firebase của app Android.

```bash
gcloud auth login
gcloud config set project <PROJECT_ID>

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  speech.googleapis.com firestore.googleapis.com storage.googleapis.com iamcredentials.googleapis.com

# Bucket lưu âm thanh và ảnh (chọn region gần bạn)
gcloud storage buckets create gs://<PROJECT_ID>-meetmind --location=asia-southeast1 --uniform-bucket-level-access
```

Firestore: tạo database ở chế độ Native trong Firebase Console (nếu chưa có), rồi đẩy rules và indexes:

```bash
npm i -g firebase-tools
cd firebase && firebase deploy --only firestore --project <PROJECT_ID>
```

Rules từ chối mọi truy cập từ client, nên Android phải đi qua backend.

Gemini: tạo API key ở https://aistudio.google.com/apikey (free tier). Gói Gemini Plus cá nhân không tính vào API.

Budget alert: **Billing → Budgets & alerts**, đặt 5 USD.

## 3. Chạy local

```bash
cp .env.example .env        # điền GCP_PROJECT_ID, STORAGE_BUCKET, GEMINI_API_KEY
gcloud auth application-default login
npm install
npm run dev                 # http://localhost:8080/health
npm test
```

Ký signed URL cần quyền ký. Cách nhanh khi chạy local: tạo service account có quyền Storage Object Admin và Datastore User, tải khóa JSON, đặt `GOOGLE_APPLICATION_CREDENTIALS=./service-account.json` trong `.env` (file này đã bị `.gitignore`).

Lấy ID token để thử API (dùng tài khoản đã đăng ký và đã xác thực email trong app, `WEB_API_KEY` ở Firebase Console → Project settings):

```bash
curl -s -X POST "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=WEB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"a@b.com","password":"...","returnSecureToken":true}'
# lấy trường idToken (hết hạn sau 1 giờ)
TOKEN=<idToken>
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/users/me
```

Luồng thử cuộc họp:

```bash
# 1) tạo cuộc họp (consent bắt buộc để ghi âm)
curl -X POST localhost:8080/meetings -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Họp thử","consent":{"accepted":true}}'
# 2) xin URL upload, PUT file, báo xong
curl -X POST localhost:8080/meetings/<id>/audio -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
curl -X PUT "<uploadUrl>" -H "Content-Type: audio/mp4" --data-binary @test.m4a
curl -X POST localhost:8080/meetings/<id>/audio/complete -H "Authorization: Bearer $TOKEN"   # 202 {jobId}
# 3) theo dõi job, rồi lấy transcript và gọi AI
curl localhost:8080/jobs/<jobId> -H "Authorization: Bearer $TOKEN"
curl localhost:8080/meetings/<id>/transcript -H "Authorization: Bearer $TOKEN"
curl -X POST localhost:8080/meetings/<id>/summary -H "Authorization: Bearer $TOKEN"
```

## 4. Deploy lên Cloud Run

```bash
# Service account riêng cho Cloud Run
gcloud iam service-accounts create meetmind-api
SA=meetmind-api@<PROJECT_ID>.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding <PROJECT_ID> --member=serviceAccount:$SA --role=roles/datastore.user
gcloud storage buckets add-iam-policy-binding gs://<PROJECT_ID>-meetmind --member=serviceAccount:$SA --role=roles/storage.objectAdmin
# Cho phép tự ký signed URL (không cần file khóa)
gcloud iam service-accounts add-iam-policy-binding $SA --member=serviceAccount:$SA --role=roles/iam.serviceAccountTokenCreator
# Firebase Auth: cần quyền xác thực token và xóa người dùng
gcloud projects add-iam-policy-binding <PROJECT_ID> --member=serviceAccount:$SA --role=roles/firebaseauth.admin

# Khóa Gemini lưu trong Secret Manager
gcloud services enable secretmanager.googleapis.com
printf "<GEMINI_KEY>" | gcloud secrets create gemini-api-key --data-file=-
gcloud secrets add-iam-policy-binding gemini-api-key --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor

gcloud run deploy meetmind-api --source . --region asia-southeast1 --allow-unauthenticated \
  --service-account $SA --memory 1Gi --cpu 1 --timeout 900 --no-cpu-throttling \
  --set-env-vars GCP_PROJECT_ID=<PROJECT_ID>,STORAGE_BUCKET=<PROJECT_ID>-meetmind,NODE_ENV=production \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest
```

`--allow-unauthenticated` là bình thường: mọi endpoint (trừ `/health`) tự kiểm tra Firebase ID token trong code.
`--no-cpu-throttling` bắt buộc vì job chạy nền sau khi trả response (xem mục Giới hạn).
Gửi URL Cloud Run cho thành viên 1 để điền vào Base URL của Android.

## 5. Endpoint đã làm (khớp Phần 4 của kế hoạch)

| Nhóm | Endpoint |
| --- | --- |
| Hệ thống | `GET /health` |
| Người dùng | `POST/GET/PATCH/DELETE /users/me`, `POST /users/me/avatar` |
| Thư mục | `GET/POST /folders`, `PATCH/DELETE /folders/{id}` |
| Cuộc họp | `POST/GET /meetings`, `GET/PATCH/DELETE /meetings/{id}` |
| Âm thanh | `POST/GET /meetings/{id}/audio`, `POST /meetings/{id}/audio/complete`, `POST /meetings/{id}/transcription` |
| Transcript | `GET /meetings/{id}/transcript`, `PATCH /meetings/{id}/speakers/{speakerId}` |
| AI | `POST/GET /meetings/{id}/summary`, `POST /meetings/{id}/action-items/extract`, `POST/GET /meetings/{id}/mindmap` |
| Việc cần làm | `GET/POST /meetings/{id}/action-items`, `PATCH/DELETE /action-items/{itemId}` |
| Chat | `POST/GET/DELETE /meetings/{id}/chat` |
| Job | `GET /jobs/{jobId}` |

Chưa làm (P1/P2): WebSocket realtime, bot Vexa, Google Calendar, insights/key-moments, analytics, search, mời thành viên, tích hợp Slack/Notion/Trello, `Idempotency-Key`.

Khác với bản hợp đồng, cần báo thành viên 1:
- `POST /users/me/avatar` nhận `{contentType}` và trả `{uploadUrl, method, headers}`; sau khi PUT xong, `GET /users/me` trả `avatarUrl` (signed 1 giờ).
- Thêm mã lỗi `TRANSCRIPT_NOT_READY` (409) khi gọi AI trước khi có transcript, và `TRANSCRIPT_EMPTY`, `AUDIO_UNREADABLE` trong `job.error.code`.
- Tên hiển thị tiếng Việt được chuẩn hóa Unicode NFC và kiểm tra ở backend (sửa lỗi số 4).

## 6. Giới hạn đã biết

- **Job chạy nền trong tiến trình** (không có Cloud Tasks): nếu instance bị tắt giữa chừng, job kẹt ở `running` (backend bỏ qua job kẹt quá 30 phút). Khi cần ổn định hơn, thay `setImmediate` trong `src/services/jobs.ts` bằng Cloud Tasks.
- **Speech-to-Text V1** với FLAC; diarization tiếng Việt chưa chắc được hỗ trợ nên code tự thử lại không diarization. Chưa kiểm tra credit $300 có trả cho Speech-to-Text; làm khi tới bước spike.
- **Danh sách `/meetings`**: lọc theo `folderId`, `tag`, `status`, `from`, `to` làm trong bộ nhớ trên từng trang 50 bản ghi.
- Model Gemini mặc định `gemini-2.5-flash`; kiểm tra model free tier hiện tại trong AI Studio và đổi `GEMINI_MODEL` nếu cần.
- Chưa chạy trên môi trường thật: cần `npm install`, `npm run typecheck`, `npm test` và thử luồng ở mục 3.

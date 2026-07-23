# 🏫 Kalinabiri Secondary School — Backend API

REST API powering the Kalinabiri SS school-management platform: students, teachers, classes, results, attendance, fees, announcements, news, gallery, auth, and a real-time socket for live updates.

## Stack

- **Language:** Node.js (Express 4)
- **Databases:** PostgreSQL (production / Railway), SQLite (local dev fallback)
- **Auth:** JWT (`Authorization: Bearer <token>`)
- **Realtime:** Socket.io for live announcements / notifications / messages
- **Uploads:** Multer (disk storage under `uploads/`)
- **Deployment:** Railway (Dockerfile + `railway.json`)

## Quick start (local dev, SQLite — no setup needed)

```bash
cd backend
npm install
# Start with empty DATABASE_URL → falls into the SQLite branch automatically
DATABASE_URL="" JWT_SECRET=dev-secret node server.js
```

The first boot creates `kalinabiri.db`, seeds a random admin password (printed to stdout — grab it from the log), and brings the API up on `:3000`.

## Quick start (Postgres — production)

```bash
# .env
DATABASE_URL=postgres://user:pass@host:5432/kalinabiri
JWT_SECRET=<strong random string>
PORT=3000
NODE_ENV=production
ALLOWED_ORIGINS=https://kalibz-international.netlify.app
```

On first boot against an empty Postgres database, the server creates every table, runs the migrations for previously-deployed DBs, and seeds the admin user (`admin@kalinabiriss.ac.ug` / `Admin@2026`) plus 4 teachers and 10 subjects. **Change that default password immediately.**

## Docker / Railway

```bash
docker build -t kalinabiri-backend .
docker run -p 3000:3000 \
  -e DATABASE_URL=postgres://... \
  -e JWT_SECRET=... \
  kalinabiri-backend
```

`railway.json` declares `healthcheckPath: /api/health` and `restartPolicyType: ON_FAILURE`. Pushing to the linked Railway service redeploys automatically.

## Smoke test

A self-contained end-to-end smoke test exercises every key route group. It spawns the server on an ephemeral port, drives 30+ requests through the public/auth/admin/student paths, and prints PASS/FAIL per check.

```bash
cd backend
rm -f kalinabiri.db kalinabiri.db-shm kalinabiri.db-wal   # clean slate
node smoke_test.js
```

Expected output: `Total: 30, Passed: 30, Failed: 0`.

`NODE_ENV=test` lifts the per-IP rate limits so the smoke test can run hundreds of requests in seconds without tripping the limiter.

## API endpoints

Public (no auth):

| Method | Path                    | Purpose                              |
|--------|-------------------------|--------------------------------------|
| GET    | `/api/health`           | Liveness probe (Railway healthcheck) |
| GET    | `/api/announcements`    | Active announcements (expires_at > now) |
| GET    | `/api/news`             | Published news items                 |
| GET    | `/api/gallery`          | Gallery items                        |
| GET    | `/api/classes`          | Classes                              |
| GET    | `/api/subjects`         | Subjects                             |
| GET    | `/api/settings`         | Public site settings                 |
| POST   | `/api/contact`          | Contact form                         |

Auth:

| Method | Path                       | Purpose                              |
|--------|----------------------------|--------------------------------------|
| POST   | `/api/auth/register`       | Register (student/teacher/admin)     |
| POST   | `/api/auth/login`          | Login → returns JWT                   |
| GET    | `/api/auth/me`             | Current user                         |
| PUT    | `/api/auth/password`       | Change password                      |
| PUT    | `/api/auth/profile`        | Update profile                       |
| POST   | `/api/auth/request-verification` | Request email-verification code |
| POST   | `/api/auth/verify-email`   | Submit verification code             |
| POST   | `/api/auth/forgot-password`| Request password-reset code          |
| POST   | `/api/auth/reset-password` | Submit reset code                    |

Admin (role: admin):

| Method | Path                          | Purpose                          |
|--------|-------------------------------|----------------------------------|
| GET    | `/api/admin/stats`            | Dashboard counts                 |
| GET/POST/PUT/DELETE | `/api/admin/users[/:id]` | User CRUD                |
| GET    | `/api/admin/students`         | Students list (joined)           |
| POST   | `/api/admin/students`         | Create student                   |
| GET/POST/PUT/DELETE | `/api/admin/teachers[/:id]` | Teacher CRUD             |
| GET/POST/PUT/DELETE | `/api/admin/classes[/:id]`  | Class CRUD                |
| GET/POST/PUT/DELETE | `/api/admin/subjects[/:id]` | Subject CRUD              |
| GET/POST/PUT/DELETE | `/api/admin/announcements[/:id]` | Announcement CRUD     |
| GET/POST/PUT/DELETE | `/api/admin/news[/:id]`    | News CRUD                   |
| GET/POST/PUT       | `/api/admin/results[/:id]`  | Result CRUD                 |
| GET/POST/PUT       | `/api/admin/fees[/:id]`     | Fee CRUD                    |
| GET/POST           | `/api/admin/attendance`     | Attendance                  |
| GET/POST/PUT/DELETE | `/api/admin/assignments[/:id]` | Assignment CRUD         |
| GET/POST/PUT       | `/api/admin/submissions[/:id]` | Grade submissions        |
| GET/POST/DELETE    | `/api/admin/gallery[/:id]`  | Gallery upload/delete         |
| GET/PUT             | `/api/admin/settings`      | Site settings                |
| GET/PUT             | `/api/admin/site-content`  | Site content blocks           |
| GET                 | `/api/admin/activities`    | Audit log                    |

Student (role: student):

| Method | Path                          | Purpose                          |
|--------|-------------------------------|----------------------------------|
| GET    | `/api/student/dashboard`      | Dashboard bundle                 |
| GET    | `/api/student/assignments`    | Assignments for student's class  |
| GET    | `/api/student/submissions`    | Own submissions                  |
| POST   | `/api/student/submissions`    | Submit assignment                |
| GET    | `/api/student/fees`           | Own fee ledger                   |
| GET    | `/api/results`                | Own results                      |

Teacher (role: teacher):

| Method | Path                          | Purpose                          |
|--------|-------------------------------|----------------------------------|
| GET    | `/api/teacher/students`       | Students in teacher's classes    |

Common:

| Method | Path                          | Purpose                          |
|--------|-------------------------------|----------------------------------|
| GET    | `/api/messages`               | Inbox / sent                     |
| POST   | `/api/messages`               | Send                             |
| GET    | `/api/notifications`          | Notification feed                |
| PUT    | `/api/notifications/:id/read` | Mark one read                    |
| PUT    | `/api/notifications/read-all` | Mark all read                    |
| POST   | `/api/upload`                 | Single file upload               |
| POST   | `/api/upload/multiple`        | Multi-file upload                |

## Project layout

```
backend/
├── server.js           # Express app + routes + initDB()
├── db.js               # SQLite wrapper (Pool-shaped), placeholder + SQL translator
├── smoke_test.js       # End-to-end smoke test (spawns server, 30+ checks)
├── Dockerfile          # node:20-alpine + native build deps
├── railway.json        # Railway deploy manifest
├── package.json
├── .env.example
└── uploads/            # user-uploaded files (gitignored)
```

## Security

See `../SECURITY.md` for the full notes. Headlines:

- `JWT_SECRET` is mandatory — server exits at boot if missing.
- `ALLOWED_ORIGINS` (comma-separated) restricts CORS; defaults to localhost only.
- `helmet()` enabled; `express-rate-limit` on `/api/*`.
- All admin routes require `requireRole('admin')` middleware.
- The previous Netlify token leak in `frontend/` is documented and `.env` is git-ignored.

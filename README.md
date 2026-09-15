# Self Hub

The Trinity Degree's Bond performance record — a real, deployed system
(Node/Express + PostgreSQL, hosted on Railway), replacing the artifact-based
tracker whose storage scope couldn't be confirmed and had no phone-reliable
path. This is the same stack as Cattle Manager, so it slots into your
existing workflow.

**First module: BND-101 (The Standard)** — bodyweight, lifts, and benchmark
logging, a dashboard with trend charts, and a weekly AI-coach prompt
assembled server-side from your real data.

This is meant to grow the way Cattle Manager did: new Bond units (BND-106
Vertical, BND-201 Dive, marksmanship, etc.) become new tables and routes
under this same app, not new standalone tools. One deployment, one login,
one place your physical record lives.

## Stack

- Backend: Node.js / Express 5
- Frontend: single static page, vanilla JS + Chart.js (no build step)
- Database: PostgreSQL
- Auth: HTTP Basic Auth via environment variables (same as Cattle Manager —
  your browser will prompt for the username/password itself, no login page
  to build)
- Deploy: Railway, auto-deploy from GitHub on push

## Local development

```
npm install
cp .env.example .env
# edit .env with a local Postgres connection string and your own credentials
npm start
```

Runs migrations automatically on boot, then serves the app on
`http://localhost:3000` (or `$PORT`).

## Running the tests

```
npm test
```

This runs an integration test against an in-memory Postgres (no real
database needed) — it boots the actual server, hits every API route, and
checks the computed summary and coach-prompt logic. Useful before you push
a change.

## Deploying — first time

1. **Create the GitHub repo.** Suggested name: `jakegayler-dot/self-hub`,
   matching your existing repos. Push this project to it:
   ```
   git init
   git add .
   git commit -m "Self Hub — BND-101 fitness module"
   git branch -M main
   git remote add origin https://github.com/jakegayler-dot/self-hub.git
   git push -u origin main
   ```
2. **Create a new Railway project** and choose "Deploy from GitHub repo" →
   select `self-hub`.
3. **Add a PostgreSQL plugin** to the project (Railway → New → Database →
   PostgreSQL). Railway wires `DATABASE_URL` into your app automatically —
   you don't set it yourself.
4. **Set the two environment variables** on the app service (not the
   database): `SELF_HUB_USER` and `SELF_HUB_PASS`. Pick a real password,
   not the placeholder in `.env.example`.
5. **Do not set `PORT` manually** — Railway injects it, and a manual value
   causes the same conflict it caused on the House Hub deploy.
6. Railway builds and deploys automatically. Once it's live, open the
   generated `*.up.railway.app` URL — your browser will prompt for the
   username/password you set in step 4, then the app loads. Works from any
   phone browser, since it's just a website.
7. From here, every `git push` to `main` auto-deploys — same as Cattle
   Manager.

## What "API-ready for Sentinel" actually means here

This isn't a documented contract waiting to be built later — the routes
under `/api/fitness/*` are a real, live API right now:

- `GET /api/fitness/summary` — the computed dashboard state (7-day average,
  weekly rate, latest lifts, entry counts)
- `GET /api/fitness/coach-prompt` — the assembled coaching prompt, including
  Sentinel's own last 3 notes so it has continuity across sessions
- `GET/POST/DELETE /api/fitness/coach-notes` — the write-back channel: this
  is where Sentinel's output persists, distinct from the raw logs, and it
  shows up in the app's Coach tab either way
- Full CRUD on `/bodyweight`, `/lifts`, `/benchmarks`, `/profile`

When Sentinel exists as a running service, it calls these same endpoints.
Nothing here needs to be rebuilt — Sentinel becomes another authenticated
client of this API, the same way your own browser is now. It authenticates
with its own `SENTINEL_USER`/`SENTINEL_PASS` pair (see `.env.example`)
rather than your personal login, so either credential can be rotated without
touching the other.

## A security note from the build

While building this, `dotenv@17.4.2` was found to print an unsolicited
message to the console on every load, addressed at "agents" and pointing
to an external URL (`vestauth.com`). That URL was not visited and the
message was not acted on. The project is pinned to `dotenv@16.4.5` instead,
which does not do this — don't bump past that without checking the
changelog first.

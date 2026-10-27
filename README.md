# Self Hub



## Stack

- Backend: Node.js / Express 5
- Frontend: single static page, vanilla JS + Chart.js (no build step)
- Database: PostgreSQL
- Auth: a login page (`/login`) with `SELF_HUB_USER`/`SELF_HUB_PASS`; signing in sets a signed
  400-day cookie so the device stays signed in (renewed as it's used; changing the password signs every
  device out). Basic Auth still works for Sentinel (`SENTINEL_USER`/`SENTINEL_PASS`) and scripts.
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

This runs the integration tests against an in-memory Postgres (no real
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

## Sentinel push (Fitness tile)

Self Hub pushes a small summary to Sentinel so its Fitness tile stays current:

    POST {SENTINEL_URL}/v1/sources/self_hub/summary
    Authorization: Bearer {SENTINEL_API_KEY}

| Variable | Required | What it is |
| --- | --- | --- |
| `SENTINEL_URL` | for the push | Sentinel's base URL, e.g. `https://sentinel.up.railway.app` (no trailing path) |
| `SENTINEL_API_KEY` | for the push | The `self_hub` source key issued by Sentinel |

If either is unset the push is off and the server logs that once. When on,
it pushes ~60 s after any successful POST/PUT/DELETE under `/api`
(debounced, at most 5 min behind a steady stream of writes), ~30 s after
boot, and every 6 h. Failures retry with backoff (1, 2, 4 … 60 min); a failed
push never affects a request.

The body is `{ generated_at, summary: { strength, training_week, needs_input } }`:

- `strength` — the same numbers as the Health tab's Strength profile: best
  e1RM per benchmark lift within the last 2 months ÷ average bodyweight over
  those 2 months, scored against bodyweight-ratio tiers, grouped by movement
  pattern (accessory lifts excluded). `overall_score` is the mean of the
  pattern scores (the Health tab has no single overall number). The maths
  lives in `server/lib/strength.js`, which the page also loads (as
  `/js/strength.js`), so the two cannot disagree.
- `training_week` — strength sessions (distinct days with a lift logged)
  Monday–Sunday in Regina time, against the weekly strength-session goal.
- `needs_input` — things only you can fix, e.g. no recent bodyweight.

`GET /api/fitness/sentinel-preview` (behind the normal login) returns exactly
what would be sent, without sending it.

## Workout generator (Train tab)

Generates single sessions or a whole week from your logged data and a few
constraints — date, minutes, focus, equipment, engine machine — and saves them
so each set logs with one tap into the same tables the Log tab writes.

- **Strength / gymnastics** (`server/lib/workoutGen.js`, movement library in
  `server/lib/movements.js`): fills this week's least-trained patterns (vs the
  ≥10 sets/pattern/week bar on the dashboard), gives the heavy work to your
  weakest strength-profile patterns, steers accessories to the V-taper levers
  (lateral delts first), and avoids repeating a pattern or family within a day.
  Loads are % of your best e1RM in the last 60 days; gymnastics reps come from
  your best set. Core work is bodyweight only.
- **Engine** (`server/lib/engine.js`), built the way The Gains Lab works:
  time trials per machine (10-min max, 1-min max, 6 × 0:30/0:30) → endurance
  pace, speed pace, repeatability → every interval gets a personal target
  (e.g. threshold = 92% of your 10-min pace for 4 min). Logged results move the
  next targets up to ±6%; tests older than 8 weeks are rescheduled; your
  speed-reserve and repeatability scores pick which energy system gets
  priority. Gains Lab's own formulas aren't public — these percentages are
  standard energy-system targets, tunable in `SESSION_TYPES`.
- Every workout carries `rationale` — why each choice was made — shown under
  "Why this workout".

## CrossFit percentiles (Dashboard)

Shown alongside the bodyweight-ratio strength levels: % of the field each of
your bests beats (`server/lib/percentiles.js`, `GET /api/fitness/percentiles`,
Sentinel read collection `crossfit_percentiles`).

- Back squat, deadlift, clean & jerk, snatch, max pull-ups, 400 m / 5 km run,
  Fran, Grace, Helen, Filthy 50, Fight Gone Bad → male CrossFitters'
  self-reported 2019 Open athlete profiles (quartiles, leblancfg.com).
  Optimistic pool, not bodyweight-adjusted.
- 500 m / 2k / 5k row → Concept2 2025 rankings, lightweight men (times at the
  10/25/50/75/90% positions).
- Open → your rank ÷ athletes in your division from the official leaderboard
  (`/open-results`).
- Lifts: best e1RM in 60 days (singles at face value), else 12 months,
  flagged. Everything else: best Rx result in 12 months. Benchmarks now have
  an Rx flag; scaled results don't count.

## Sentinel trainer agent: refining workouts

Hybrid: the rules build the workout; Sentinel's trainer agent can refine it.
Sentinel **pulls** — nothing new is needed on Sentinel's API. Using the
`SENTINEL_USER`/`SENTINEL_PASS` login:

1. `GET /api/fitness/workouts/refine-queue` → `{ pending, requests: [...] }`.
   Each request has the rule-built `workout`, Jake's `jake_note`, the
   `constraints` (minutes, equipment), an `athlete` block (goals,
   measurements, strength scores, 60-day e1RMs, gymnastics bests, engine
   baselines, sets this week by pattern, last 7 days, this week's plan),
   `known_movements`, `instructions` and the `response_schema`.
2. `PUT /api/fitness/workouts/:id/refined` with `{ "body": {...}, "notes": "..." }`.
   The body is validated and rebuilt from known fields only (logging state is
   never accepted from outside); a `422` lists exactly what to fix. The rules
   version is kept, so Jake can revert from the Train tab.

Refinement is refused (`409`) once Jake has logged a set from that workout.
The agent can also read workouts through the Sentinel read API
(`/api/sentinel/read/workouts`) or call any route via the action bridge.

Main routes (all under `/api/fitness`): `POST /workouts/generate`,
`POST /workouts/generate-week`, `GET /workouts`, `POST /workouts/:id/log`,
`/unlog`, `/metcon`, `/regenerate`, `/refine`, `/revert`, `GET /engine`,
`POST /engine-tests`. See the header of `server/routes/workouts.js`.

## A security note from the build

While building this, `dotenv@17.4.2` was found to print an unsolicited
message to the console on every load, addressed at "agents" and pointing
to an external URL (`vestauth.com`). That URL was not visited and the
message was not acted on. The project is pinned to `dotenv@16.4.5` instead,
which does not do this — don't bump past that without checking the
changelog first.

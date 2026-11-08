# kyivrunner-bot — master plan (v3, as built)

A Telegram bot that hands out Kyiv Digital transit QR tickets from **one** personal account to a
small, admin-approved group, without sharing the account's credentials.

Repository: https://github.com/illya4git/kyivrunner-bot · API reference: [docs/](docs/README.md) ·
Operations: [README.md](README.md)

## Status

**Phases 1–7 are built** (123 tests, typecheck clean). **Phase 8, the live smoke test, is next.**

| Phase | Scope | Status |
|---|---|---|
| 1. Foundation | Config, DB + migrations, i18n, roles, audit middleware, public commands, admin user management | ✅ Done |
| 2. Mock API + KyivClient | Stateful mock, control plane, client (envelope, rate limit, retries, error mapping), contract tests | ✅ Done |
| 3. Credentials + card | `/credentials` entry and health, encryption, alerts, `/card` | ✅ Done. Login with the real token verified. |
| 4. Tickets | `/qr`, quotas, safeguards, one message per ticket, lost-response recovery | ✅ Done |
| — Mock control panel | HTML panel at `/_mock/` (moved up from phase 6) | ✅ Done |
| 5. Tracking | Background tracker, place of use, image retirement, startup reconciliation, dev clock | ✅ Done |
| 6. Admin reporting | `/settings` `/set` `/pause` `/resume` `/stats` `/logs` `/export`, alerts, pruning | ✅ Done |
| 7. Ship | Dockerfile, compose files, backups, healthcheck, runbook | ✅ Done. amd64 verified; arm64 not built yet. |
| — Publish | Public GitHub repo, secret scrubbed from history, no-reply author email | ✅ Done |
| 8. Live smoke test | Deploy on the target box, real `/qr`, use/expiry, place, backups, health | 🔄 In progress: deployed; issue, use and expiry work live; place lookup reworked after the first live run (D30) |

### Verification status

| Item | Status |
|---|---|
| Request envelope and card listing against the real API | **Verified live** (credential entry and `/card`) |
| Generate, `/qr` list, ticket use and expiry | **Verified live** (2026-11-07/08: 6 tickets issued, 4 used, 1 expired) |
| `used_at` vs the feed's `created_at` | **Verified live:** equal to the second |
| `/qr` lag (scan → `used_at` visible) | **Observed live:** 1–8 minutes |
| Feed lag (scan → `val_` visible) | Longer than `/qr`'s; not measured yet. `place_found` events now record it (`foundAfterSec`) |
| Nightly maintenance | **Observed live** at 01:11: generate → 422 with the end time; all reads 200 (D34) |
| Used codes drop out of `/qr` ~2 h after the scan | **Observed live:** one code listed at 1 h 26 min and gone at 2 h 02 min after its scan; another gone at 3.8 h. The bot (D31) and the mock handle it |
| Error responses the mock guessed (422 on a blocked or empty card, 401 on a device mismatch) | Unverified. The client handles any 4xx either way. |
| Token refresh (`/auth/refresh`) | Not used: tokens are re-entered by admins |
| Docker image on amd64 | Built and run here (migrations, non-root, config errors, mock image) |
| Docker image on arm64 | **Not built yet** (no emulation on the dev host). Every component publishes arm64 builds. |
| Backup restore procedure (README) | Backups are tested; the restore steps aren't |

---

## Decisions log

| # | Decision |
|---|---|
| D1 | Place of use comes from the per-card **feed** (`val_` events), matched by time: the code's `used_at` vs the event's `created_at`. |
| D2 | **One card** for everyone (`active_card_id`, picked at credential setup or with `/card`). |
| D3 | Quota counts **issued** codes per Kyiv day. |
| D4 | A global daily cap and a trip reserve, both on by default and admin-tunable. |
| D5 | UI in **Ukrainian and English**, picked from Telegram's `language_code` (`uk` → Ukrainian, anything else → English), switchable with `/lang`. |
| D6 | Credentials are entered **in the bot chat**. Each message is deleted right after reading. |
| D7 | Admins hear about a guest **only on `/request`**. |
| D8 | Deployment is a **single Docker container** with one volume, multi-arch (`linux/amd64`, `linux/arm64`). |
| D9 | The event log is kept for **365 days** (`log_retention_days`), pruned nightly. |
| D10 | **One Telegram message per ticket.** A repeat request replies to it. It's re-sent only if the user deleted it. |
| D11 | A **controllable mock Kyiv Digital API** with a control panel, used in development and in tests. |
| D12 | **Every status change** (used, expired) edits the ticket message **and** replies to it, so the user gets a notification. |
| D13 | Users see **places** in their own `/history`. |
| D14 | The QR image is **kept when the code is used** (conductor re-scans). Expiry swaps it for a placeholder; a used ticket's image is swapped silently after midnight. |
| D15 | Credential entry is a **two-step in-memory state machine** (token, then UUID), with `/cancel` and a 10-minute timeout. The grammY conversations plugin was dropped: it rebuilds the context on every step, losing `ctx.user`/`ctx.t`. |
| D16 | **Token hygiene everywhere:** any message that looks like a JWT is deleted, whoever sends it; JWTs inside commands are logged as `[jwt]`; free text is logged by length only. |
| D17 | **GETs are retried, generate never is.** A generate whose response was lost is reconciled against a code snapshot taken just before generating, instead of reserving a second trip. |
| D18 | The **tracker sync runs under the issuing lock**, so a code mid-issue is never mistaken for a foreign one. **No separate midnight cron:** the tracker handles expiry and image retirement within one poll interval. |
| D19 | ~~Place lookup: one attempt the moment a code turns used, then up to 3 tracker retries.~~ Replaced by D30. Still true: The first caption and reply say "finding the place…" and are edited once it's known. A feed event is linked to at most one ticket (an in-code filter plus a unique column). |
| D20 | The **mock control panel** was moved up (shipped after phase 4). It's served by the mock at `/_mock/`. The mock's request log records only `/api/*` calls. |
| D21 | `npm run dev:mock` **resets the bot's mock database on each start** (users and roles kept), provisions dev credentials and the card, and makes the mock follow the bot's clock. |
| D22 | **`/dev clock`** (`+2h`, `-30m`, `+1d`, `midnight`, `reset`) and **`/dev tick`** for admins in DEV_MODE. |
| D23 | **Alerts:** credentials invalid/restored; expiry at 14/7/3/1 days and on expiry; low balance and blocked generation once per Kyiv day (deduplicated through the audit log, so restarts don't repeat them); a Kyiv Digital outage after 5 failed tracker passes, once per incident, plus recovery. |
| D24 | **`/logs [user] [count]`** arguments are positional. Interactions are hidden unless a user is given. |
| D25 | The app's static **`X-Client-Auth` is not in the repository.** It comes from `KYIV_CLIENT_AUTH` (required for the real API); the mock uses a placeholder. The repo is public, the value was scrubbed from all history before the first push, and commits use the GitHub no-reply address. |
| D26 | Compose keeps secrets in **`.env` via `env_file`**, without listing variables in the compose file. |
| D27 | **Health** = polling Telegram and a recent tracker pass (within the slower poll interval + max backoff + 5 min: 15 min by default). Credential problems are reported, but don't fail the check (a restart wouldn't fix them). |
| D28 | `TELEGRAM_TEST_ENV` switches to Telegram's test servers. The fake Telegram in tests validates HTML the way Telegram does. |
| D29 | **Adaptive polling:** fast (30s) `/qr` only while a ticket issued in the last 15 min is unused; otherwise 5 min (the feed got its own cadence in D30). Most codes are scanned soon after issue; for an older one the user can press 🔄 or send /status, and expiry is reported within 5 min of midnight. Issuing wakes the tracker. All three values are settings. |
| D30 | **Scheduled place search** (after the first live run, where all 4 lookups gave up before the feed caught up): the feed has its own cadence, like `/qr`. A used ticket is searched from `place_search_delay_min` (5) after its scan, every 30 s until 15 min after the scan, then every 5 min, giving up after `place_give_up_hours` (6). One feed request per card serves every pending ticket, so the worst case is one `/qr` and one feed call every 30 s. The default `place_match_window_sec` dropped to 30, since matches are exact. Places are shown as `🚇 Метро · Видубичі 1 (захід)` / `🚌 Автобус №87 · МАЗ 215-069` (on surface transport the "place" is often the vehicle). |
| D31 | **A code missing from `/qr` before its expiry counts as used** (used codes drop out ~2 h after the scan). Its time and place come from the earliest unclaimed `val_` event between issue and the moment it went missing. Without this, a ticket used while the bot was down for 2+ hours was reported "expired unused" at midnight. |
| D32 | **Admins have no per-user daily quota** (they can change quotas anyway). The global daily cap and the trip reserve still apply to them. A quota stored for an admin takes effect if they're demoted. |
| D33 | **Polling jitter:** every tracker interval (`/qr`, feed, idle pass) varies by ±20%, re-rolled after each request, so the calls don't form an exact rhythm. The place-search delay and give-up time are not jittered. |
| D34 | **Nightly maintenance** (00:00–01:00 until 03:00 Kyiv; only generate is refused, with a 422 naming the end time). The client recognises the message, records the end time, and from then on **sends no requests at all** until it passes (`KyivError` `maintenance`, raised locally). `/qr` replies with a translated "🌙 … after 03:00", isn't charged to the quota, and is logged as `cap_denied` `reason: maintenance`; the start is logged once as a `maintenance` event. The tracker keeps its idle passes (liveness, images) without API calls and resumes within a minute of the end. Admins are alerted only if it starts outside 23:30–04:00 (once a day). The window isn't blocked in advance, because generation may still work between 00:00 and its actual start. No "notify me" button (decided against). |
| D35 | **Placeholder images are static files** (`assets/ticket-used.png`, `assets/ticket-expired.png`, replace them with any artwork of the same names) and **uploaded to Telegram only once**: the returned `file_id` is stored in `telegram_files` under a key that includes a hash of the image, and reused for every later swap. A changed image gets a new key (one new upload); an id Telegram rejects (e.g. after switching bot tokens) is forgotten and the image uploaded again. QR images are unique per ticket and still uploaded. |

---

## 1. Facts from the API that shape the design

| Fact (docs/) | Consequence for the bot |
|---|---|
| Generate = `POST /api/v4/card/travel/{id}/qr-ticket`, empty body, returns **all** codes, new one first | Generation is serialized. The new code is identified against a snapshot taken just before generating (D17). |
| A QR is a **day pass**: `expire_at` = local midnight; `used_at` is set when validated | A ticket goes `active → used` or `active → expired`. |
| Each generation **reserves one trip**; unused ones come back at midnight (`eqr_`) | Quota counts issued codes. The one-active-code rule stops hoarding. |
| No way to cancel or revoke a code | A lost QR means pointing the user back to the same code. |
| `GET /api/v4/qr` lists every code with `used_at` | One shared tracker checks all active tickets in one call. |
| Feed `val_` events carry mode (`title`) and station (`description`), but no code id | Place = the `val_` event nearest the code's `used_at` (D19). |
| The feed may include personal data | Only the matched event's id, mode and place are stored. |
| 60 req/min **per token**, shared with the owner's phone app | Self-imposed limit, default 20/min (`api_rate_per_min`). |
| Token lives ~186 days; `401` = stale; refresh unverified | No refreshing. Admins re-enter it and are warned from the JWT `exp`. |
| Prefer a **residential UA IP** | Runs on a home box. Telegram long polling, no inbound ports. |
| Day boundaries are Kyiv-local | Every "day" is computed in `Europe/Kyiv`, DST-safe. |
| `X-Client-Auth` is a static app secret | Supplied through `KYIV_CLIENT_AUTH`, never committed (D25). |

---

## 2. Stack

| Concern | Choice |
|---|---|
| Runtime | Node 24 LTS, TypeScript 7 (strict), ESM |
| Telegram | grammY + `auto-retry` + `transformer-throttler` |
| DB | SQLite via `better-sqlite3` (WAL), Drizzle ORM + `drizzle-kit` migrations, applied on startup |
| Validation | zod 4: env, admin input, every Kyiv Digital response |
| QR | `qrcode` → PNG. Placeholders are drawn procedurally (no binary assets). |
| Scheduling | `croner` (Kyiv TZ) for expiry warnings (10:00), pruning (03:30), backups (04:00); the tracker loop for everything else |
| i18n | Typed dictionaries `i18n/{uk,en}.ts`; a missing key fails the build |
| Logging | pino (redacted) to stdout. The audit trail is in the DB. |
| Crypto | AES-256-GCM (`node:crypto`) |
| Mock API | `node:http` with a small router, plus a single-file HTML panel |
| Tests | vitest: the mock in-process, in-memory SQLite, and a fake Telegram that records calls, validates HTML and simulates deleted messages |
| Packaging | Multi-stage Dockerfile (`node:24-bookworm-slim`, tini, non-root), compose |

---

## 3. Architecture

```
  Telegram (long polling)
        │
  bot/  core middleware (private chats only → user + locale → audit) → credential entry → JWT guard
        → public commands → user commands → admin commands (+ /dev) → fallback
        TicketView (presenter), Notifier, CommandMenus, alerts wiring
        │
  services/
    AccessService      roles, /request flow, quotas, last-admin protection
    TicketService      issue (lock, quotas, safeguards, snapshot, reconciliation), transitions, places, retirement
    TicketTracker      background passes: retire images, sync under the lock, pending places, foreign codes, backoff
    PlaceResolver      feed matching by time, one event ↔ one ticket
    CredentialService  encrypted storage, health from live results, expiry checks
    SettingsService    typed settings registry
    AuditService       append-only events, alert dedup, pruning
    StatsService       reporting queries
        │
  kyiv/  KyivClient: envelope, rate limiter, retries, error mapping, zod schemas
  db/    Drizzle schema + client      core/  config, clock, crypto, csv, backup, health, logger, mutex
```

Rules:
- Handlers hold no logic. Services never import grammY: Telegram I/O goes through `TicketPresenter` (implemented by `TicketView`) and service events (`EventEmitter`) wired to admin alerts in `bot/alerts.ts`.
- `buildServices()` wires the same service graph for `main.ts`, `dev:mock` and the tests.
- One `KyivClient` owns the rate-limit budget. The process clock is injectable and shiftable in dev.

### KyivClient error mapping
| HTTP | Action |
|---|---|
| 200 | zod parse; a mismatch is logged with the differing fields and raised as `shape` |
| 401 / 423 | `unauthorized`: the credentials are marked invalid, use stops, admins are alerted once |
| 429 | GET: wait out `Retry-After` once (≤30s). POST: no retry. |
| 5xx / network / timeout | GET: 2 retries with jitter. POST (generate): never retried; flagged `ambiguous` and reconciled (D17). |
| other 4xx | `rejected`, with the server's message shown |

---

## 4. Domain rules

### Roles
`guest` (default), `user`, `admin`, `banned`.
- Guests can ask with `/request`: admins get [Grant] [Ban] [Ignore]. One pending request per guest, and a 24h cooldown after an ignore.
- Banned users are ignored silently but logged. Group chats are logged and never create users.
- `ADMIN_IDS` admins can't be demoted from the bot, and the last admin can't be demoted either.

### `/qr` (or 🎫)
1. Not paused, credentials usable, active card set.
2. Fetch the code list (this refreshes the user's ticket and is the snapshot). Still active → reply to its message, or re-send it if the message was deleted.
3. Quota (issued today < user quota). If it's used up and today's used ticket is still valid, point to it for inspection.
4. Global cap, card `canGenerate`, trips > `reserve_trips`.
5. Under the lock: generate → identify the new code against the snapshot → record it. On an ambiguous failure, look for the new code in the list rather than retrying.
6. Send the protected photo with a caption (label, valid until, quota) and [🔄 Refresh].

### The single ticket message (TicketView)
| Event | Action |
|---|---|
| Issued | Send photo + caption + [🔄] |
| Repeat request / `/status` | Reply to it; re-send once if it's gone |
| Used | Edit the **caption only** (the QR stays), remove the button; **reply** "✅ used at 08:14 — 📍 finding the place…" |
| Place found (from 5 min after the scan) | Edit the caption and the earlier reply; no new notification |
| Place given up (6 h after the scan) | Edit the "finding the place…" note away |
| Expired | Swap in the ⏰ placeholder + caption; **reply** "⌛ expired unused" |
| Used, after midnight | Silently swap in the ✓ placeholder with a final caption |
| Message deleted | Mark it gone; notify with a standalone text message |

### Tracking (TicketTracker)
Two endpoints, each with its own cadence: `poll_interval_sec` (30s) when fresh, otherwise `poll_idle_interval_sec` (5 min). The loop wakes when either is due; 30s–5min of backoff is added after Kyiv Digital failures.

| Endpoint | Fresh (30s) | Otherwise (5 min) | Stops |
|---|---|---|---|
| `/qr` | a ticket issued < `poll_fresh_window_min` (15) ago is unused | any ticket active | nothing active |
| feed | a pending place's scan was 5–15 min ago | any place pending (from 5 min after the scan) | found, or `place_give_up_hours` (6) after the scan |

Each pass:
1. Retire used images past midnight (DB only).
2. If `/qr` is due: list codes under the issuing lock → transitions (a code missing before expiry = used, D31); log foreign codes once.
3. If the feed is due: one request per card, matched against every searchable pending ticket.

Issuing (which just listed the codes) and a ticket turning used wake the tracker.

The first pass runs at startup and reconciles anything that happened while the bot was down. Idle passes make no API calls. A rejected token stops all calls until it's fixed.

### Credentials
`/credentials set` → token (format and expiry checked) → UUID → probed against Kyiv Digital → saved encrypted; the card is auto-picked or chosen. Health: `missing` / `ok` / `expiring` (<14 days) / `expired` / `invalid`. `/credentials check` re-tests; `clear` removes them.

---

## 5. Data model (SQLite)

```sql
users(tg_id PK, username, first_name, last_name, locale ('uk'|'en'), locale_overridden,
      role ('guest'|'user'|'admin'|'banned'), daily_quota NULL, access_requested_at, request_ignored_at,
      note, created_at, last_seen_at, role_changed_at, role_changed_by)

credentials(id PK, token_enc, token_iv, token_tag, device_uuid, token_sub, token_exp,
            status ('ok'|'invalid'|'replaced'), added_by, added_at, last_ok_at, last_error_at, last_error)

settings(key PK, value, updated_by, updated_at)

tickets(id PK, kd_ticket_id UNIQUE, user_tg_id → users, card_id, code, kyiv_day, label,
        status ('active'|'used'|'expired'), issued_at, expire_at, used_at,
        place, mode, kd_feed_event_id UNIQUE, place_attempts, place_search_from, place_gave_up_at,
        chat_id, message_id, message_gone, resend_count, status_reply_id, image_retired)

events(id PK, ts, tg_id NULL, role_at_time, kind, data JSON)

telegram_files(key PK, file_id, updated_at)   -- reusable uploads, see D35
```

Migrations: `0000_init`, `0001_ticket_label`, `0002_place_search` (also re-opens the search for used tickets that never got a place), `0003_telegram_files`.

Event kinds: `interaction`, `denied`, `access_requested`, `access_request_ignored`, `ticket_issued`,
`ticket_pointed`, `ticket_resent`, `ticket_used` (with `reportedAfterSec` or `missingFromList`), `ticket_expired`, `place_found` (with `foundAfterSec`), `place_unresolved`, `quota_denied`,
`cap_denied`, `role_changed`, `quota_changed`, `locale_changed`, `setting_changed`, `credentials_set`,
`credentials_cleared`, `credentials_invalid`, `credentials_expiring`, `api_error`, `maintenance`, `foreign_code`,
`paused`, `resumed`, `admin_alert`, `exported`.

---

## 6. Settings (`/settings`, `/set`)

| Key | Default | Meaning |
|---|---|---|
| `default_daily_quota` | 2 | Tickets per user per Kyiv day |
| `global_daily_cap` | 6 | Tickets per day for everyone |
| `reserve_trips` | 4 | Stop issuing at this many trips or fewer |
| `low_balance_alert` | 8 | Alert admins at this many trips or fewer |
| `active_card_id` | — | Set via `/card` or credential setup |
| `poll_interval_sec` | 30 | Fresh cadence for `/qr` and the feed |
| `poll_idle_interval_sec` | 300 | Cadence otherwise |
| `poll_fresh_window_min` | 15 | Fresh = issued (unused) or scanned this recently |
| `place_match_window_sec` | 30 | Max gap between `used_at` and the feed event |
| `place_search_delay_min` | 5 | Start the place search this long after the scan |
| `place_give_up_hours` | 6 | Stop the place search this long after the scan |
| `api_rate_per_min` | 20 | Self-imposed Kyiv Digital limit |
| `request_cooldown_hours` | 24 | Wait before another `/request` after an ignore |
| `log_retention_days` | 365 | Event pruning |
| `paused` | false | Set via `/pause`, `/resume` |

Environment: see README (`BOT_TOKEN`, `ADMIN_IDS`, `ENCRYPTION_KEY`, `KYIV_CLIENT_AUTH`, `DB_PATH`,
`BACKUP_DIR`, `BACKUP_KEEP`, `HEALTH_PORT`, `LOG_LEVEL`, `KYIV_BASE_URL`, `DEV_MODE`, `TELEGRAM_TEST_ENV`).

---

## 7. Telegram UI

Private chats only; per-role command menus in the user's language; a 🎫 QR reply keyboard for users and admins.

- **Everyone:** `/start`, `/help`, `/whoami`, `/lang`
- **Guests:** `/request`
- **Users:** `/qr` (🎫), `/status`, `/history`
- **Admins:** `/users` (card: role, quota, 📊 stats, 📜 log), `/requests`, `/grant`, `/revoke`, `/quota`, `/settings`, `/set`, `/stats [today|week|month|all]`, `/logs [id|@user] [count]`, `/export [tickets|events] [days|all]`, `/card`, `/credentials [set|check|clear]`, `/cancel`, `/pause`, `/resume`
- **Admins in DEV_MODE:** `/dev clock …`, `/dev tick`

---

## 8. Mock Kyiv Digital API (`mock/`)

The real API's paths and shapes, with strict envelope checks (X-Client-Auth placeholder, Bearer, device binding, no `Content-Type` on generate) and simulated rate-limit headers. State: cards, codes, feed, tokens, clock. Trips are reserved on generate and returned at midnight.

- **Control panel** at `/_mock/` (`/` redirects there). **JSON control plane** under `/_mock/*`: validate (station, feed delay), expire, midnight, clock, owner-generate, physical-card tap, card patch/add, tokens issue/revoke, faults (`401 423 429 500 503 shape timeout drop lost maintenance`), nightly maintenance (generate refused 00:00–03:00 Kyiv by the mock clock, toggle), latency, reset, state, requests, endpoints.
- **Runs:** `npm run mock` (alone), `npm run dev:mock` (with the bot, D21), the `mock` Docker target with `compose.dev.yaml`, and in-process in tests.

---

## 9. Security

- The token is AES-256-GCM encrypted at rest, never logged, masked in the UI; token-shaped messages are deleted (D16). Accepted trade-off: entry passes through Telegram.
- `X-Client-Auth` lives only in `.env` (D25).
- QR messages use `protect_content`; exports never include QR payloads; only the matched station and mode are stored from the feed.
- Every admin action is audited.

---

## 10. Deployment

- Multi-stage Dockerfile: build (with a toolchain fallback), `mock` target, pruned prod deps, non-root runtime with tini, `/data` volume, `HEALTHCHECK` on `127.0.0.1:${HEALTH_PORT}/healthz`.
- `compose.yaml` (one service, `env_file: .env`, log rotation); `compose.dev.yaml` (production image + mock).
- Nightly `VACUUM INTO` backups to `/data/backups`, keeping 14. Migrations on startup; graceful SIGTERM.
- Image: 416 MB uncompressed (mostly the Node runtime).

---

## 11. Project layout

```
src/
  main.ts  jobs.ts
  core/      config clock crypto csv backup health html logger mutex
  db/        schema client
  kyiv/      client envelope schemas rate-limit errors maintenance
  services/  index access audit credentials settings tickets places tracker stats telegram-files
  bot/       bot context deps menus keyboards notifier alerts role-effects ticket-view kyiv-errors
             place  middleware/core  commands/{public,user-tickets,admin-users,admin-credentials,admin-card,admin-reports,fallback,dev}
  i18n/      uk en index
  qr/        render (QR images), placeholder (loads assets/)
mock/        server state fixtures jwt main dev panel.html
drizzle/     0000_init 0001_ticket_label 0002_place_search 0003_telegram_files
test/        helpers/{services,telegram,telegram-html,kyiv,ticket-env}  *.test.ts
assets/      ticket-used.png  ticket-expired.png
Dockerfile  compose.yaml  compose.dev.yaml  .env.example  README.md  PLAN.md  docs/
```

---

## 12. Next: phase 8, the live smoke test

On the target box (residential connection), with the real account:

1. `cp .env.example .env` and fill it in, **including `KYIV_CLIENT_AUTH`**. Then `docker compose up -d --build` (the first arm64 build).
2. `/credentials set`, then `/card`.
3. `/qr` once. This reserves a real trip; if unused, it returns at midnight.
4. Scan it (uses the trip) or let it expire. Check the reply, the place, how long the feed takes, and the image swap after midnight.
5. `docker ps` shows `healthy`, and a backup appears after 04:00.
6. Feed back any differences (error codes, feed lag, response fields) into the client, the mock and these docs.

### Open items
- arm64 image build (happens on the Pi, or with QEMU on the dev host).
- Read `foundAfterSec` from `place_found` events and tune `place_search_delay_min` / `place_give_up_hours`.
- Restore drill from a backup.
- `npm audit`: a moderate advisory in drizzle-kit's bundled esbuild (dev-only, not in the image).

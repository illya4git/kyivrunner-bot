# kyivrunner-bot — master plan (v2)

A Telegram bot that hands out Kyiv Digital transit QR tickets from **one** personal account to a
small, admin-approved group, without sharing the account's credentials.

API reference: [docs/](docs/README.md). Status: **design agreed in principle, not yet built.**

### Decisions log
| # | Decision |
|---|---|
| D1 | Place of use comes from the per-card **feed** (`val_` events). We match the code's `used_at` to the event's `created_at`. |
| D2 | **One card** for everyone (`active_card_id` setting). |
| D3 | Quota counts **issued** codes per Kyiv day. |
| D4 | A global daily cap and a trip reserve are both on by default and admin-tunable. |
| D5 | UI in **Ukrainian and English**, auto-picked from Telegram `language_code`, overridable with `/lang`. |
| D6 | Credentials are entered **in the bot chat**. The messages are deleted right after reading. |
| D7 | Admins are notified about a guest **only on `/request`**. |
| D8 | Deployment is a **single Docker container**, multi-arch (`linux/amd64`, `linux/arm64`). |
| D9 | The event log is kept for **365 days**. |
| D10 | **One Telegram message per ticket.** It's never re-sent while it exists. A repeat `/qr` replies to it. Status changes edit that one message. |
| D11 | A **controllable mock Kyiv Digital API** (with a control panel) for development and tests. |
| D12 | **Every status change** (used, expired) does two things: it **edits** the ticket message, and it posts a short **reply** to that message so the user gets a notification. Not configurable. |
| D13 | Users see **places** in their own `/history`. |
| D14 | The QR image is **kept when the code is used**, for conductor re-scans. It's replaced with a placeholder only at expiry. A used ticket's image is swapped silently at midnight. |

---

## 1. Facts from the API that shape the design

| Fact (docs/) | Consequence for the bot |
|---|---|
| Generate = `POST /api/v4/card/travel/{id}/qr-ticket`, empty body, returns **all** codes, new one is `codes[0]` | Generation is **serialized** (global mutex), and `codes[0].id` is checked against the DB. |
| A QR is a **day pass**: `expire_at` = local midnight; `used_at` becomes non-null when the code is validated | A ticket goes `active → used` or `active → expired`. |
| Each generation **reserves one trip**. Unused ones come back at midnight (`eqr_` event) | Quota counts issued codes. The one-active-code rule stops hoarding. |
| No way to cancel or revoke a code | A lost QR means pointing the user back to the same code, never generating a replacement. |
| `GET /api/v4/qr` lists every code with `used_at` | One shared **poller** tracks all active tickets in one call. |
| `GET /card/travel/{id}/feed`: `type:1` / `val_` events carry mode (`title`) and station/stop (`description`), but no code id | Place = the `val_` event whose `created_at` best matches the code's `used_at`. The feed is fetched only when a code turns *used*. |
| The feed may include personal data (`info` block) | Only the matched event's fields are stored. The raw feed is never persisted or logged. |
| 60 req/min **per token**, shared with the owner's phone app | Self-imposed limit, default **20/min**. |
| Token lives ~186 days; `401` = stale; refresh is unverified | No refreshing. Admins re-supply the token, and get warned early using the JWT `exp` claim. |
| Prefer a **residential UA IP** | The container runs on a home box (ARM is fine). Telegram **long polling**, no inbound ports. |
| Day boundaries are Kyiv-local | Every "day" is computed in `Europe/Kyiv`, independent of the host TZ. |

---

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Node 24 LTS**, TypeScript (strict), ESM | Native `fetch`, already on the host. |
| Telegram | **grammY** + `auto-retry` + `transformer-throttler` | TS-first. The two-step credential entry is a small in-memory state machine. The conversations plugin rebuilds the context on every step, which loses `ctx.user`/`ctx.t`. |
| DB | **SQLite** via `better-sqlite3`, WAL mode | One file, synchronous, fast. Prebuilt binaries exist for linux-arm64 and x64. |
| Schema / queries | **Drizzle ORM** + `drizzle-kit` SQL migrations | Typed, little overhead. Migrations are committed and applied on startup. |
| Validation | **zod** | Env, admin input, and **every Kyiv response** (fail loudly if the API shape drifts). |
| QR image | `qrcode` → PNG buffer | Plus a static "USED" / "EXPIRED" placeholder image for edits. |
| Scheduling | `croner` (Kyiv TZ) + the tracker loop | Midnight sweep, token-expiry warnings, daily DB backup, log pruning. |
| i18n | Typed TS dictionaries `i18n/{uk,en}.ts` | `en` is typed as `typeof uk`, so a missing key fails the **build**. No runtime i18n framework needed. |
| Logging | `pino` with `redact` | Operational logs only. The audit trail lives in the DB. |
| Crypto | `node:crypto` AES-256-GCM | Encrypts the access token at rest. |
| Mock API | `node:http` + a tiny router (Hono) and one static HTML control panel | Same code used in vitest (in-process) and in dev (a separate process). |
| Tests | **vitest** | Services against the mock API and in-memory SQLite. Bot handlers through a grammY API transformer that records outgoing calls. |
| Packaging | Multi-stage Dockerfile, `docker buildx` for amd64 + arm64 | One container, one volume `/data`. |

---

## 3. Architecture

```
  Telegram (long polling)
        │
  bot/  middleware: private-chat only → upsert user + locale → audit "interaction" → role guard
        handlers: public / user / admin commands, callback queries, conversations
        │
  services/
    AccessService      roles, /request flow, grant/revoke, last-admin protection, per-role command menus
    TicketService      /qr: point to existing or generate; quotas; safeguards; mutex
    TicketTracker      poll GET /qr → transitions → PlaceResolver → TicketView.update
    PlaceResolver      feed fetch + used_at↔created_at matching (with retries for feed lag)
    TicketView         owns THE ticket message: send once, reply-to, edit on change, detect deletion
    CredentialService  encrypted token store, validation, JWT exp, health state
    SettingsService    typed key/value settings with defaults
    AuditService       append-only events, stats/export queries
    Notifier           admin alerts (deduped), respects pause
        │
  kyiv/  KyivClient — header envelope, rate limiter, retry/backoff, error mapping, zod schemas
  db/    Drizzle schema, migrations, repositories
  core/  config (zod env), Clock (Kyiv TZ, injectable), crypto, logger, mutex
```

Rules:
- **Handlers hold no logic.** Services never import grammY types. Telegram I/O goes through `TicketView` and `Notifier`, which are thin interfaces with fakes for tests.
- **One `KyivClient`** owns the rate-limit budget. Its base URL is configurable, which is how it gets pointed at the mock.
- **Injectable `Clock`**, so tests can jump to midnight.

### KyivClient error mapping
| HTTP | Action |
|---|---|
| 200 | zod parse. On a mismatch, log a redacted body and raise `ApiShapeError`. |
| 401 / 423 | Mark the credentials `invalid`, block generation, alert admins once. |
| 429 | GET: wait out `Retry-After` once (capped at 30s). POST: no retry. Users see "busy, try again shortly". |
| 5xx / network / timeout | GET: 2 retries with jitter. **POST (generate): never retried.** A lost response may still have reserved a trip, so the error is flagged `ambiguous` and TicketService reconciles via `GET /qr` (phase 4). |

---

## 4. Domain rules

### Roles
`guest` (default), `user`, `admin`, `banned`.
- **Guests** get "No access. Send /request to ask for it." `/request` notifies all admins with [✅ Grant user] [🚫 Ban] [Ignore]. One pending request per guest, with a **24h cooldown** after an ignore.
- **Banned** users are ignored silently but still logged.
- Bootstrap admins come from env `ADMIN_IDS`. They can't be demoted from inside the bot, and the last admin can't be demoted either.
- Every update from every role is written to the audit log.

### `/qr` (or the 🎫 button)
1. Role ≥ user, the bot isn't paused, and credentials are `ok`/`expiring`.
2. **The user has an active ticket** → refresh it from the API first (it may have just been used).
   - Still active → `TicketView.pointTo(ticket)`: send a short **reply to the existing ticket message** ("⬆️ Your active QR is here, valid until 23:59").
   - That reply fails with *message to be replied not found* (the user deleted it) → **re-send the QR photo once** and store the new `message_id`. Log a `ticket_resent` event.
   - Telegram doesn't report deletions in private chats, so the reply attempt itself *is* the deletion check. It costs one call and needs no extra probing.
3. No active ticket → check the **user daily quota** (issued today < `users.daily_quota ?? default_daily_quota`).
4. **Global safeguards:** issued today across all users < `global_daily_cap`; card `monthly_tickets_balance` > `reserve_trips`; `actions.generate_qr && !qr_generate_blocked`.
5. Under the **generation mutex**: POST generate → `codes[0]` → insert the `tickets` row.
6. `TicketView.send(ticket)`: one photo message (`protect_content: true`) with a caption (card label, valid until, quota n/N) and a [🔄 Refresh] button. Store `chat_id` and `message_id`.

### The single ticket message (TicketView)
| Event | Action on the one message |
|---|---|
| Issued | Send photo + caption + [🔄 Refresh] |
| Repeat `/qr` | Reply to it (re-send only if it's gone) |
| 🔄 Refresh pressed | Re-check the API, edit the caption if anything changed, answer the callback with a toast |
| Used | **Edit the caption only** (`editMessageCaption`). **The QR image stays**, because conductors may re-scan it to check the ride. Caption: ✅ used at 08:14, 🚇 Metro, Politekhnichnyi Instytut. Keep the QR open for inspection until 23:59. Button removed. **Reply:** "✅ Your QR was used at 08:14 — Metro, Politekhnichnyi Instytut". |
| Place resolved late (feed lag) | **Edit** the caption to add the place. No second reply. The first reply says "place pending…" and is edited too. |
| Expired | **Edit:** `editMessageMedia` → "EXPIRED" placeholder. Caption: ⌛ not used, the trip went back to the card. **Reply:** "⌛ Your QR expired unused". |
| Used ticket passes `expire_at` (midnight) | **Silent** `editMessageMedia` → "USED" placeholder. The QR is no longer valid, so it no longer needs to be shown. There's no reply and no status change: the ticket stays `used`. Done by the midnight sweep. |
| Conductor check, but the message of a **used, not yet expired** ticket was deleted | `/status` (or 🎫 while the quota is exhausted) replies to the used ticket's message. If that's gone too, it re-sends the QR once, captioned "✅ already used at 08:14, for inspection". This never generates a new code. |
| Message deleted | The edit fails → set `message_gone = 1`. The status update is then sent as a **standalone text message** (no QR image), so the user is still notified. |

Each status change is always an edit **plus** a reply. Telegram doesn't notify on edits, so the reply is what pings the user. Replies are always text, never a new QR. Their ids are stored (`status_reply_id`), so a late place resolution can edit the reply as well.

**Reply rules:** a user has at most one ticket active at a time, and every ticket transitions at most once. That caps notifications at one per ticket, so no extra dedup is needed. If tickets reach the midnight sweep in bulk, replies are paced by the throttler.

### Tracking (TicketTracker)
- Runs only while active tickets exist: `GET /api/v4/qr` every `poll_interval_sec` (default 30s).
- `used_at` set → status `used` → PlaceResolver → TicketView edit.
- `expire_at` passed → status `expired`. A cron at 00:01 Kyiv time also sweeps for these.
- Codes the bot didn't issue (the owner using the app) → a `foreign_code` event, otherwise ignored.
- On startup, every `active` row is reconciled.

### Place resolution (PlaceResolver)
- On a transition to *used*, fetch `feed?page=1&per_page=30`. Take `type == 1` events. Pick the one with the smallest `|created_at − used_at|` within `place_match_window_sec` (default 120s) that isn't already linked to another ticket (`val_` id is unique in the DB).
- No match yet (feed lag) → retry on the next 3 poll cycles, then give up with `place = NULL` (and log `place_unresolved`).
- Store `place` (= `description`), `mode` (= `title`), and `kd_feed_event_id`. Nothing else from the feed is stored.

### Credentials (in chat)
`/credentials set` starts a conversation: it asks for the token, then the device UUID. **Each message is deleted right after it's read.** The bot then validates with `GET /api/v4/card/travel`, decodes the JWT `exp`, and stores the token encrypted. If the account has more than one card, the admin picks the active one from buttons.
Health states: `ok` / `expiring` (exp < 14 days) / `invalid` / `missing`. Admins get warnings at 14, 7, 3, and 1 days before expiry, and right away on `invalid`.

---

## 5. Data model (SQLite)

```sql
users(
  tg_id INTEGER PK, username, first_name, last_name,
  locale TEXT CHECK(locale IN ('uk','en')), locale_overridden INTEGER DEFAULT 0,
  role TEXT CHECK(role IN ('guest','user','admin','banned')) DEFAULT 'guest',
  daily_quota INTEGER NULL,                 -- NULL = default
  access_requested_at, request_ignored_at,  -- /request flow
  note, created_at, last_seen_at, role_changed_at, role_changed_by
)

credentials(                                 -- history kept; one row active
  id PK, token_enc BLOB, token_iv BLOB, token_tag BLOB, device_uuid,
  token_sub, token_exp, status, added_by, added_at, last_ok_at, last_error_at, last_error
)

settings(key TEXT PK, value TEXT, updated_by, updated_at)

tickets(
  id PK, kd_ticket_id INTEGER UNIQUE, user_tg_id → users, card_id,
  code TEXT,                                -- needed for a one-time re-send; valid ≤ 1 day
  kyiv_day TEXT,                            -- 'YYYY-MM-DD'
  status TEXT CHECK(status IN ('active','used','expired')),
  issued_at, expire_at, used_at,
  place TEXT NULL, mode TEXT NULL, kd_feed_event_id TEXT UNIQUE NULL, place_attempts INTEGER DEFAULT 0,
  chat_id, message_id, message_gone INTEGER DEFAULT 0, resend_count INTEGER DEFAULT 0,
  status_reply_id INTEGER NULL              -- the notification reply, edited if the place resolves late
)
  INDEX (user_tg_id, kyiv_day), INDEX (status)

events(id PK, ts, tg_id NULL, role_at_time, kind TEXT, data JSON)
  INDEX (ts), INDEX (tg_id, ts), INDEX (kind, ts)
```

Event kinds: `interaction`, `denied`, `access_requested`, `ticket_issued`, `ticket_pointed`,
`ticket_resent`, `ticket_used`, `ticket_expired`, `place_unresolved`, `quota_denied`, `cap_denied`,
`role_changed`, `quota_changed`, `setting_changed`, `credentials_set`, `credentials_invalid`,
`api_error`, `foreign_code`, `paused`, `resumed`.

---

## 6. Settings (admin-tunable, with defaults)

Defaults assume a student monthly pass of about 46 trips, i.e. roughly 1.5 per day.

| Key | Default | Meaning |
|---|---|---|
| `default_daily_quota` | 2 | Codes per user per Kyiv day |
| `global_daily_cap` | 6 | Codes per day across everyone |
| `reserve_trips` | 4 | Never generate if the monthly balance is ≤ this (kept for the owner) |
| `low_balance_alert` | 8 | Alert admins once a day when the balance is ≤ this |
| `active_card_id` | — (picked at credential setup) | Which travel card to use |
| `poll_interval_sec` | 30 | Tracker cadence while tickets are active |
| `place_match_window_sec` | 120 | Max `used_at` ↔ feed `created_at` gap |
| `api_rate_per_min` | 20 | Self-imposed Kyiv API limit |
| `request_cooldown_hours` | 24 | Delay before an ignored guest can `/request` again |
| `log_retention_days` | 365 | Prune `events` after this many days |
| `paused` | false | Kill switch |

---

## 7. Telegram UI

Private chats only. Each role gets its own command menu via `setMyCommands` (with per-chat scope
for users and admins, and both `uk` and `en` `language_code` variants), refreshed whenever a role changes.
Users get a persistent reply keyboard with a single **🎫 QR** button.

**Everyone:** `/start`, `/help`, `/whoami`, `/lang uk|en`
**Guest:** `/request`
**User:** `/qr` (🎫), `/status` (today's n/quota + replies to the active ticket message, if any), `/history` (your last 10 tickets: date, outcome, time used, 🚇 mode + place)
**Admin:**
| Command | Behaviour |
|---|---|
| `/users` | Paged inline list → user card with [User] [Admin] [Guest] [Ban] [Quota…] [Stats] [Logs] |
| `/requests` | Pending access requests with Grant/Ban/Ignore buttons |
| `/grant <id\|@user> [user\|admin]`, `/revoke <id>`, `/quota <id> <n\|default>` | Text shortcuts |
| `/settings` | Every setting with its current value. `/set <key> <value>` changes one (validated, audited) |
| `/stats [today\|week\|month]` | Per user: issued / used / expired, top places. Global totals. Card balance |
| `/logs [id] [n]` | Recent audit events |
| `/export [tickets\|events] [days]` | CSV document |
| `/card` | Balance, trips left, credential health, token expiry date |
| `/credentials [set\|clear]` | Health + masked token / entry conversation |
| `/pause`, `/resume` | Kill switch |

**Admin alerts:** an access request, credentials invalid or expiring, low balance, repeated API errors, generation blocked by the card.

---

## 8. Mock Kyiv Digital API (`mock/`)

A stateful fake server that follows `docs/` exactly, so both the UI and the logic can be exercised without a real token.

**API surface (the same paths and shapes as the real one):** `GET /api/v4/card/travel`, `GET /api/v4/card/travel/{id}`,
`GET …/{id}/feed`, `POST …/{id}/qr-ticket`, `GET /api/v4/qr`. It **checks the envelope** (static `X-Client-Auth`, Bearer token,
device UUID, and *no* `Content-Type` on generate), so client mistakes show up in dev. Rate-limit headers are simulated too.

**State:** cards (balance, monthly tickets, blocked flag), codes, feed events, accepted tokens, and a clock offset.
Generation decrements the balance and adds a `qrt_` event. It's seeded from fixtures copied from the docs.

**Control plane (`/_mock/*`, JSON) + an HTML panel at `/_mock/`:**
| Control | Effect |
|---|---|
| `POST /_mock/codes/{id}/validate {mode, place, delay_feed_sec?}` | Simulates a scan: sets `used_at` and adds a `val_` event, optionally delayed to test feed lag |
| `POST /_mock/codes/{id}/expire` | Sets `expire_at` to now, returns the trip, adds an `eqr_` event |
| `POST /_mock/midnight` | Expires everything unused at once |
| `POST /_mock/owner-generate` | A code created "from the phone app" (a foreign code) |
| `POST /_mock/foreign-validation` | A `val_` event with no code (physical card tap), to test matching |
| `PATCH /_mock/card {balance, blocked, generate_qr}` | Card state |
| `POST /_mock/faults {status: 401\|423\|429\|503\|shape, count \| rate, latency_ms}` | Fault injection |
| `POST /_mock/tokens {valid:[…], exp}` | Token validity / an expiring JWT (the mock signs a fake JWT with a chosen `exp`) |
| `POST /_mock/reset` | Back to the fixtures |

The panel lists active codes with "Scan at [station ▾]" and "Expire" buttons, card state, a fault toggle, and a live request log. You can drive the bot from a phone with one hand and the panel with the other.

**Usage:**
- **Dev:** `npm run dev:mock` starts the mock on `:8787` and the bot with `KYIV_BASE_URL=http://localhost:8787`. Use a separate dev bot token from @BotFather.
- **Tests:** vitest starts the mock in-process on an ephemeral port per test file. Scenarios cover quota, the one-active rule, deleted-message re-send, place matching under lag and decoys, 401 handling, the midnight sweep, and concurrent `/qr` from two users (mutex attribution).
- **Safety:** the bot refuses a non-`https://kyiv.digital` base URL unless `DEV_MODE=true`. With `DEV_MODE` on, a `/dev` admin command shifts the bot's clock, for testing quota day rollover.

---

## 9. Security

- The token is encrypted at rest (AES-256-GCM, `ENCRYPTION_KEY` env var). It's redacted from logs and masked in the UI.
- Credential messages are deleted right after reading. Accepted trade-off: bot chats aren't end-to-end encrypted, so the token passes through Telegram's servers.
- QR messages use `protect_content`. Leaking a code costs at most one trip on one day.
- Feed personal data is never stored. Only the matched station, mode, and event id are kept.
- Every admin action is audited along with who performed it. `ADMIN_IDS` can't be revoked from inside the bot.

---

## 10. Deployment (single container, ARM-ready)

- **Dockerfile:** multi-stage on `node:24-bookworm-slim`.
  - Build stage: `npm ci` (with build tools in case no `better-sqlite3` prebuild is available) → `tsc`.
  - Runtime stage: prod deps + `dist/` + `drizzle/`, a non-root user, `tini` as PID 1.
- **Images:** `docker buildx build --platform linux/amd64,linux/arm64`. Targets a Raspberry Pi 4/5 on a **64-bit** OS. 32-bit armv7 isn't a goal.
- **Volume:** `/data` holds `bot.sqlite` plus `backups/`. A nightly `VACUUM INTO` backup keeps 14 copies.
- **Env:** `BOT_TOKEN`, `ADMIN_IDS`, `ENCRYPTION_KEY`, `DB_PATH=/data/bot.sqlite`, optional `KYIV_BASE_URL`, `DEV_MODE`, `LOG_LEVEL`.
- **Healthcheck:** a tiny internal HTTP `/healthz` on localhost reporting the bot-loop heartbeat, DB status, and credential health (not exposed outside the container).
- `compose.yaml` for production, plus a `compose.dev.yaml` that adds the mock service.
- Migrations run on startup. SIGTERM shuts things down gracefully (stop polling, stop the tracker, close the DB).

---

## 11. Project layout

```
src/
  main.ts
  core/      config.ts clock.ts crypto.ts logger.ts mutex.ts health.ts
  db/        schema.ts client.ts migrate.ts repos/*.ts
  kyiv/      client.ts envelope.ts schemas.ts rate-limit.ts errors.ts
  services/  access.ts tickets.ts tracker.ts place.ts ticket-view.ts credentials.ts settings.ts audit.ts notifier.ts
  bot/       bot.ts middleware/*.ts commands/{public,user,admin,dev}/*.ts conversations/*.ts keyboards.ts
  i18n/      uk.ts en.ts index.ts
  qr/        render.ts assets/{used,expired}.png
mock/        server.ts state.ts fixtures.ts jwt.ts control.ts panel.html
drizzle/     migrations
test/        helpers/ (mock bootstrap, telegram recorder, fake clock)  *.test.ts
Dockerfile  compose.yaml  compose.dev.yaml  .env.example  README.md
```

---

## 12. Build phases

1. **Foundation:** repo scaffolding, config, DB + migrations, i18n skeleton, bot with roles, audit middleware, `/start` `/help` `/whoami` `/lang` `/request`, admin user management.
2. **Mock API + KyivClient:** mock server, fixtures, and control plane (no panel yet). Client with envelope, limiter, errors. Contract tests of the client against the mock.
3. **Credentials + card:** `/credentials` conversation, encryption, health, `/card`.
4. **Tickets:** TicketService + TicketView (`/qr`, quotas, safeguards, mutex, reply-to / re-send).
5. **Tracking:** tracker, PlaceResolver, message edits, midnight sweep, startup reconciliation.
6. **Admin reporting:** `/stats` `/logs` `/export` `/settings` `/pause`, alerts. (The mock control panel was moved earlier and shipped after phase 4.)
7. **Ship:** Dockerfile (multi-arch), compose files, backups, healthcheck, README/runbook.
8. **Live smoke test** against the real API with your token (read-only first, then one real generate).

## 13. Remaining open points
None. The design is ready to build, starting with phase 1.

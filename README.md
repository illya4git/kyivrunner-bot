# kyivrunner-bot

A Telegram bot that hands out Kyiv Digital transit QR tickets from **one** personal account to an
admin-approved group, without sharing the account's credentials.

- Repository: https://github.com/illya4git/kyivrunner-bot
- Design, decisions and status: [PLAN.md](PLAN.md)
- Kyiv Digital API reference: [docs/](docs/README.md)

## How it works

- People write to the bot. Strangers are **guests**: they're logged and can ask for access with
  `/request`. Admins approve them as **users**.
- A user taps **🎫 QR** and gets a QR code generated from the owner's Kyiv Digital account. Each
  user has at most one active code at a time and a daily quota. A global daily cap and a trip
  reserve protect the owner's monthly balance.
- Each ticket lives in **one Telegram message**. A repeat request replies to it. When the code is
  used, the caption shows the time and place and the QR stays for conductor re-scans; it's
  swapped for a placeholder after midnight. Unused codes expire at midnight (the trip returns to
  the card). Every status change also sends a short reply, so the user gets a notification.
- Admins manage access, quotas and settings, and see stats, logs and CSV exports.
- The Kyiv Digital token is supplied by an admin in the chat, encrypted at rest, and watched:
  admins are alerted when it's rejected or about to expire.

## Deploying (Docker)

Runs as one container with one volume on `linux/amd64` and `linux/arm64` (Raspberry Pi 4/5 with a
64-bit OS). It needs outbound HTTPS only (Telegram long polling; no inbound ports). Run it on a
**residential Ukrainian connection**: Kyiv Digital treats datacenter/VPN traffic as a risk signal.

```bash
git clone https://github.com/illya4git/kyivrunner-bot.git && cd kyivrunner-bot
cp .env.example .env
#   BOT_TOKEN         from @BotFather
#   ADMIN_IDS         your Telegram user id (comma-separated for several)
#   ENCRYPTION_KEY    openssl rand -base64 32   ← keep a copy somewhere safe
#   KYIV_CLIENT_AUTH  the app's static X-Client-Auth value (not in this repo)
docker compose up -d --build
docker compose logs -f bot
```

To build on one machine for the other architecture:
`docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/kyivrunner-bot --push .`
(the build host needs QEMU emulation, e.g. via `tonistiigi/binfmt`).

### First-time setup (in Telegram, as an admin)

1. `/start`, then `/credentials set`. Send the access token, then the device UUID, both taken from
   the **same** Kyiv Digital app install (see [docs/building-a-qr-client.md](docs/building-a-qr-client.md)).
   Each message is deleted as soon as it's read.
2. `/card` should show your card and trips left. If the account has several cards, pick one.
3. Review `/settings`. Defaults: 2 tickets per user per day, 6 per day overall, 4 trips kept in
   reserve, a low-balance alert at 8.
4. Tell people to message the bot and send `/request`. Approve them from the notification or with
   `/requests`.

## Configuration

Environment (`.env`):

| Variable | Default | Meaning |
|---|---|---|
| `BOT_TOKEN` | — | Telegram bot token (required) |
| `ADMIN_IDS` | — | Comma-separated Telegram ids that are always admins (required) |
| `ENCRYPTION_KEY` | — | 32 bytes, base64. Encrypts the Kyiv Digital token. **Losing or changing it means re-entering the credentials** (required) |
| `DB_PATH` | `./data/bot.sqlite` (`/data/bot.sqlite` in Docker) | SQLite database |
| `BACKUP_DIR` | `backups/` next to the database | Nightly backups |
| `BACKUP_KEEP` | `14` | Backups to keep |
| `HEALTH_PORT` | `8080` | Local `GET /healthz` for the container healthcheck (`0` disables it) |
| `LOG_LEVEL` | `info` | `debug` shows every Kyiv Digital request with status and timing |
| `KYIV_CLIENT_AUTH` | — | The Kyiv Digital app's static `X-Client-Auth` header (64 hex chars). Required for the real API; deliberately not in this repository |
| `KYIV_BASE_URL` | `https://kyiv.digital` | Anything else requires `DEV_MODE=true` |
| `DEV_MODE` | `false` | Enables `/dev` and non-production API URLs |
| `TELEGRAM_TEST_ENV` | `false` | Use Telegram's separate test servers |

Runtime settings are changed in the bot with `/set` (see `/settings` for descriptions).

## Commands

| Who | Commands |
|---|---|
| Everyone | `/start`, `/help`, `/whoami`, `/lang` |
| Guests | `/request` |
| Users | `/qr` or the 🎫 button, `/status`, `/history` |
| Admins | `/users` (role, quota, stats and log per user), `/requests`, `/grant`, `/revoke`, `/quota`, `/settings`, `/set`, `/stats [today\|week\|month\|all]`, `/logs [id\|@user] [count]`, `/export [tickets\|events] [days\|all]`, `/card`, `/credentials [set\|check\|clear]`, `/cancel`, `/pause`, `/resume` |
| Admins, DEV_MODE | `/dev clock [+2h\|-30m\|+1d\|midnight\|reset]`, `/dev tick` |

The bot speaks Ukrainian and English, chosen from the Telegram language and switchable with `/lang`.

## Operations

**Logs.** Operational logs go to stdout (`docker compose logs bot`). The audit trail (who did what,
every ticket and status change) is in the `events` table: read it with `/logs` or `/export events`.
Events older than `log_retention_days` (365) are pruned nightly at 03:30 Kyiv time.

**Health.** `docker ps` shows `healthy` when the bot is polling Telegram and the background tracker
has run within the last 10 minutes. A rejected token does not make it unhealthy, since a restart
wouldn't help; admins get an alert instead.

**Backups.** Every night at 04:00 Kyiv time a consistent copy goes to
`/data/backups/bot-YYYYMMDD-HHMMSS.sqlite`, keeping 14. The token inside stays encrypted, so a
restore also needs the same `ENCRYPTION_KEY`. To copy them off the box:
`docker compose cp bot:/data/backups ./backups`.

**Restore.**
```bash
docker compose stop bot
docker compose cp ./backups/bot-20261107-020000.sqlite bot:/data/bot.sqlite
docker compose run --rm --entrypoint sh bot -c 'rm -f /data/bot.sqlite-wal /data/bot.sqlite-shm'
docker compose start bot
```

**Upgrade.** `git pull && docker compose up -d --build`. Database migrations run on startup.
Active tickets are reconciled by the first tracker pass, so nothing is lost across restarts.

**Token renewal.** The token lives about 186 days. Admins are warned 14, 7, 3 and 1 days ahead.
Re-extract the token and UUID from the app and run `/credentials set`. If Kyiv Digital rejects the
token earlier (logged out, app reinstalled), issuing stops, admins get 🚨, and the same command fixes
it. `/credentials check` re-tests the stored token.

**Troubleshooting.**
- *"Kyiv Digital rejected the token"*: the token and UUID are from different installs, or the
  session was logged out. Enter both again.
- *📡 Kyiv Digital not responding*: usually transient. The tracker backs off (up to 5 minutes) and
  reports recovery. Check the box's internet connection if it persists.
- *Users see "limit used up"*: check `/stats today`, then adjust `/quota` or `/set default_daily_quota`.
- *Users see "running out of trips"*: the balance reached `reserve_trips`. Top up the card, or lower the reserve.
- *Response shape errors in the log*: Kyiv Digital changed its API. The log names the fields that
  differ. Compare with [docs/](docs/README.md).

## Security notes

- The access token is encrypted with AES-256-GCM. It's never logged, masked in the UI, and every
  message that looks like a token is deleted, whoever sent it. Bot chats aren't end-to-end
  encrypted, so the token does pass through Telegram when entered.
- QR messages are sent with forwarding and saving disabled. A leaked code is worth at most one
  trip on one day.
- Only the matched station and transport mode are stored from the trip feed, never the raw feed
  (it can contain personal data). Exports never include QR payloads.
- Every admin action is in the audit log. `ADMIN_IDS` admins can't be demoted from inside the bot.

## Development

Requires Node 24.

```bash
npm install
cp .env.example .env      # use a separate dev bot token
npm run dev               # bot against the real API, auto-reload
npm run dev:mock          # bot + mock API in one process (see below)
npm test                  # vitest
npm run typecheck
```

Schema changes: edit `src/db/schema.ts`, run `npm run db:generate`, and commit the new file in `drizzle/`.

### Mock Kyiv Digital API

`npm run dev:mock` starts the mock and the bot together. On each start it resets the bot's mock
database (`data/mock.sqlite`): tickets, events, credentials and settings are wiped, users and roles
are kept. It then provisions dev credentials and the card, so `/qr` works immediately. `npm run mock`
runs the mock alone (point the bot at it with `KYIV_BASE_URL=http://127.0.0.1:8787 DEV_MODE=true`).
`docker compose -f compose.dev.yaml up --build` runs the production image against the mock in
containers.

**Control panel:** http://127.0.0.1:8787/. From there you can change the card's trips and blocked
flags, scan a QR at a chosen station (with optional feed delay) or expire it, watch the feed,
copy, issue or revoke tokens, inject faults and latency, move the mock clock, and follow a live
log of API requests. The same actions are available as JSON:

| Endpoint | Effect |
|---|---|
| `GET /_mock/state`, `GET /_mock/requests`, `GET /_mock/endpoints` | Inspect everything / recent API requests / list endpoints |
| `POST /_mock/codes/{id}/validate` `{mode?, place?, feed_delay_sec?}` | Simulate a scan at a validator |
| `POST /_mock/codes/{id}/expire`, `POST /_mock/midnight` | Expire one code / jump past Kyiv midnight |
| `POST /_mock/clock` `{advance_sec \| offset_sec}` | Move the mock's clock |
| `POST /_mock/owner-generate`, `POST /_mock/foreign-validation` | Activity from the owner's phone or physical card |
| `PATCH /_mock/cards/{id}` `{trips?, blocked?, generate_qr?, locked?}`, `POST /_mock/cards` | Card state / add a card |
| `POST /_mock/tokens` `{exp_in_days?, device_uuid?}`, `POST /_mock/tokens/revoke` `{token \| all}` | Issue / revoke tokens |
| `POST /_mock/faults` `{kind, count?, rate?, path?, method?}`, `DELETE /_mock/faults` | Inject `401 423 429 500 503 shape timeout drop lost` (`lost` = processed, response dropped) |
| `POST /_mock/latency` `{ms}`, `POST /_mock/reset` | Slow down / start over |

### Dev clock

With `DEV_MODE`, admins can shift the bot's clock: `/dev clock +2h`, `-30m`, `+1d`, `midnight`,
`reset`. `/dev tick` runs a tracker pass. Under `npm run dev:mock` the mock follows the same clock,
so `/dev clock midnight` exercises expiry and image retirement end to end. The panel's clock
buttons, and `/dev clock` under `compose.dev.yaml`, move only one side.

### Telegram test environment

`TELEGRAM_TEST_ENV=true` connects to Telegram's separate test servers, which need their own
account and their own bot created with @BotFather there.

### Notes

- `npm audit` reports a moderate advisory in the esbuild copy bundled with `drizzle-kit`. It's a
  dev-only tool that never runs esbuild's dev server, and it isn't in the production image.
- Not yet verified against the live API: token refresh (not used: tokens are re-entered), and a
  few error responses the mock had to guess (422 on a blocked or empty card, 401 on a device
  mismatch). See PLAN.md, phase 8.

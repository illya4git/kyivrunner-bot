# kyivrunner-bot

A Telegram bot that hands out Kyiv Digital transit QR tickets from one personal account to an
admin-approved group, without sharing the account's credentials.

- Design and roadmap: [PLAN.md](PLAN.md)
- Kyiv Digital API reference: [docs/](docs/README.md)

## Development

Requires Node 24.

```bash
npm install
cp .env.example .env      # fill in BOT_TOKEN, ADMIN_IDS, ENCRYPTION_KEY
npm run dev               # run with auto-reload
npm test                  # vitest
npm run typecheck
```

### Mock Kyiv Digital API

```bash
npm run mock              # http://127.0.0.1:8787, prints stable dev credentials
```

Run the bot against it with `KYIV_BASE_URL=http://127.0.0.1:8787` and `DEV_MODE=true`.
The mock checks the request envelope strictly, keeps the account's state in memory, and has a
control plane at `/_mock/`:

| Endpoint | Effect |
|---|---|
| `GET /_mock/state`, `GET /_mock/requests` | Inspect cards, codes, feed, tokens, faults / recent requests |
| `POST /_mock/codes/{id}/validate` `{mode?, place?, feed_delay_sec?}` | Simulate a scan at a validator |
| `POST /_mock/codes/{id}/expire`, `POST /_mock/midnight` | Expire one code / jump past Kyiv midnight |
| `POST /_mock/clock` `{advance_sec \| offset_sec}` | Move the mock's clock |
| `POST /_mock/owner-generate`, `POST /_mock/foreign-validation` | Activity from the owner's phone or physical card |
| `PATCH /_mock/cards/{id}` `{trips?, blocked?, generate_qr?, locked?}`, `POST /_mock/cards` | Card state / add a card |
| `POST /_mock/tokens` `{exp_in_days?, device_uuid?}`, `POST /_mock/tokens/revoke` `{token \| all}` | Issue / revoke tokens |
| `POST /_mock/faults` `{kind, count?, rate?, path?, method?}`, `DELETE /_mock/faults` | Inject `401 423 429 500 503 shape timeout drop` |
| `POST /_mock/latency` `{ms}`, `POST /_mock/reset` | Slow down / start over |

### Telegram test environment

`TELEGRAM_TEST_ENV=true` connects to Telegram's separate test servers. They need their own
account and their own bot, created with @BotFather on the test server.

Schema changes: edit `src/db/schema.ts`, then run `npm run db:generate` and commit the new file in `drizzle/`.
Migrations are applied automatically on startup.

## Status

- Phase 1 (foundation): roles, audit log, `/start` `/help` `/whoami` `/lang` `/request`, and admin
  user management (`/users`, `/requests`, `/grant`, `/revoke`, `/quota`).
- Phase 2: the mock Kyiv Digital API and `KyivClient` (envelope, rate limiting, retries, error
  mapping, response validation), with contract tests against the mock.

Ticket commands reply with "not ready yet" until their phases land.

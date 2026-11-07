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

Schema changes: edit `src/db/schema.ts`, then run `npm run db:generate` and commit the new file in `drizzle/`.
Migrations are applied automatically on startup.

## Status

Phase 1 (foundation) is done: roles, audit log, `/start` `/help` `/whoami` `/lang` `/request`, and
admin user management (`/users`, `/requests`, `/grant`, `/revoke`, `/quota`).
Ticket commands reply with "not ready yet" until their phases land.

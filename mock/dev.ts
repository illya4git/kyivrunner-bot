import { loadConfig } from '../src/core/config.js';
import { processClock } from '../src/core/clock.js';
import { silentLogger } from '../src/core/logger.js';
import { openDb } from '../src/db/client.js';
import { credentials, events, settings, tickets } from '../src/db/schema.js';
import { buildServices } from '../src/services/index.js';
import { MockKyivServer } from './server.js';
import { MockState } from './state.js';

/**
 * `npm run dev:mock` — the mock Kyiv Digital API and the bot in one process.
 *
 * The mock starts empty on every run, so the bot's mock database is reset to match:
 * tickets, events, credentials and settings are wiped; users and roles are kept so test
 * accounts stay approved across restarts. The mock's dev credentials and its card are
 * then provisioned, so /qr works right away.
 *
 * Uses .env for everything except the API URL (the mock) and the database
 * (./data/mock.sqlite, or MOCK_DB_PATH).
 */
const port = Number(process.env.MOCK_PORT ?? 8787);
// The mock follows the bot's clock, so `/dev clock` moves both (panel clock buttons move only the mock).
const mock = new MockKyivServer(new MockState(() => processClock.now()));
const url = await mock.listen(port, process.env.MOCK_HOST ?? '127.0.0.1');
const dev = mock.state.devToken;

process.env.KYIV_BASE_URL = url;
process.env.DEV_MODE = 'true';
// The mock accepts the placeholder; never send the real client secret to it.
delete process.env.KYIV_CLIENT_AUTH;
// Separate DB, so mock credentials and card choice never mix with real ones.
process.env.DB_PATH = process.env.MOCK_DB_PATH ?? './data/mock.sqlite';

resetBotState();

console.log(`\nMock Kyiv Digital API on ${url} — control panel ${url}/_mock/
Bot state reset (users kept); dev credentials and card #${mock.state.cards[0]?.id} provisioned.
To try the credential flow by hand, copy the token and UUID from the panel.
`);

await import('../src/main.js');

function resetBotState(): void {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  db.transaction((tx) => {
    tx.delete(tickets).run();
    tx.delete(events).run();
    tx.delete(credentials).run();
    tx.delete(settings).run();
  });
  const s = buildServices({
    db,
    clock: processClock,
    log: silentLogger,
    adminIds: config.adminIds,
    encryptionKey: config.encryptionKey,
    kyivBaseUrl: url,
    kyivClientAuth: config.kyivClientAuth,
  });
  const by = config.adminIds[0]!;
  s.credentials.save({ accessToken: dev.token, deviceUuid: dev.deviceUuid }, by);
  const card = mock.state.cards[0];
  if (card) s.settings.set('active_card_id', card.id, by);
  db.$client.close();
}

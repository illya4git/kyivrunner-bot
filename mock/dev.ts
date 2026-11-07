import { MockKyivServer } from './server.js';

/**
 * `npm run dev:mock` — the mock Kyiv Digital API and the bot in one process.
 * Uses .env for everything except the API URL (the mock) and the database
 * (./data/mock.sqlite, or MOCK_DB_PATH).
 */
const port = Number(process.env.MOCK_PORT ?? 8787);
const mock = new MockKyivServer();
const url = await mock.listen(port, process.env.MOCK_HOST ?? '127.0.0.1');
const dev = mock.state.devToken;

process.env.KYIV_BASE_URL = url;
process.env.DEV_MODE = 'true';
// Separate DB, so mock credentials and card choice never mix with real ones.
process.env.DB_PATH = process.env.MOCK_DB_PATH ?? './data/mock.sqlite';

console.log(`\nMock Kyiv Digital API on ${url} — control plane ${url}/_mock/
Dev credentials for /credentials set:
  token:       ${dev.token}
  device uuid: ${dev.deviceUuid}
`);

await import('../src/main.js');

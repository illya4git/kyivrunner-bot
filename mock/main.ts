import { MockKyivServer } from './server.js';

/** `npm run mock` — standalone mock Kyiv Digital API for development. */
const port = Number(process.env.MOCK_PORT ?? 8787);
const host = process.env.MOCK_HOST ?? '127.0.0.1';

const mock = new MockKyivServer();
const url = await mock.listen(port, host);
const dev = mock.state.devToken;

console.log(`Mock Kyiv Digital API on ${url}

  Point the bot at it:   KYIV_BASE_URL=${url}  DEV_MODE=true

  Dev credentials (stable across restarts):
    token:        ${dev.token}
    device uuid:  ${dev.deviceUuid}

  Control plane:  ${url}/_mock/   (state: ${url}/_mock/state)
`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    void mock.close().then(() => process.exit(0));
  });
}

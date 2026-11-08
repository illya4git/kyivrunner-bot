import { silentLogger } from '../../src/core/logger.js';
import { KyivClient, type KyivClientOptions } from '../../src/kyiv/client.js';
import { MOCK_CLIENT_AUTH, type KyivCredentials } from '../../src/kyiv/envelope.js';
import { MockKyivServer } from '../../mock/server.js';

/**
 * A mock Kyiv Digital server on an ephemeral port plus a client wired to it with the
 * mock's dev credentials. Sleeps are recorded instead of awaited so retries are instant.
 */
export async function startMockKyiv(clientOpts: Partial<KyivClientOptions> = {}) {
  const mock = new MockKyivServer();
  mock.state.nightlyMaintenance = false; // runs on the real clock: don't fail at night
  const url = await mock.listen();
  const dev = mock.state.devToken;
  let creds: KyivCredentials | null = { accessToken: dev.token, deviceUuid: dev.deviceUuid };
  const sleeps: number[] = [];

  const client = new KyivClient({
    baseUrl: url,
    clientAuth: MOCK_CLIENT_AUTH,
    credentials: () => creds,
    ratePerMin: () => 60,
    log: silentLogger,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...clientOpts,
  });

  return {
    mock,
    state: mock.state,
    url,
    client,
    sleeps,
    setCredentials: (c: KyivCredentials | null) => {
      creds = c;
    },
    close: () => mock.close(),
  };
}

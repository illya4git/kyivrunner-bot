import type { Clock } from '../../src/core/clock.js';
import type { UserRow } from '../../src/db/schema.js';
import { tripsLeft } from '../../src/kyiv/schemas.js';
import { MockKyivServer } from '../../mock/server.js';
import { MockState } from '../../mock/state.js';
import { STUDENT_CARD_ID } from '../../mock/fixtures.js';
import { ADMIN_ID, FakeClock, makeServices } from './services.js';
import { makeTestBot } from './telegram.js';

const open: MockKyivServer[] = [];

/** Close every mock started by ticketEnv(); call from afterEach. */
export async function closeTicketEnvs(): Promise<void> {
  await Promise.all(open.splice(0).map((m) => m.close()));
}

/**
 * Bot + services + mock Kyiv Digital sharing one clock (default: FakeClock at
 * 2026-11-07 10:00 Kyiv), with dev credentials saved and the student card active.
 */
export async function ticketEnv<C extends Clock = FakeClock>(opts: { clock?: C; random?: () => number } = {}) {
  const clock = (opts.clock ?? new FakeClock(Date.UTC(2026, 10, 7, 8))) as C;
  const mock = new MockKyivServer(new MockState(() => clock.now()));
  open.push(mock);
  const url = await mock.listen();
  const s = makeServices({ kyivUrl: url, clock, ...(opts.random ? { random: opts.random } : {}) });
  const dev = mock.state.devToken;
  s.credentials.save({ accessToken: dev.token, deviceUuid: dev.deviceUuid }, ADMIN_ID);
  s.settings.set('active_card_id', STUDENT_CARD_ID, ADMIN_ID);
  const b = makeTestBot(s);
  const state = mock.state;

  function user(id: number, language_code = 'en') {
    s.access.touch({ id, first_name: `U${id}`, language_code });
    s.access.setRole(id, 'user', ADMIN_ID);
    return { id, first_name: `U${id}`, language_code };
  }
  const row = (id: number) => s.access.get(id) as UserRow;
  const trips = () => tripsLeft(state.cardView(STUDENT_CARD_ID)!);
  return { ...s, ...b, clock, mock, state, user, row, trips };
}

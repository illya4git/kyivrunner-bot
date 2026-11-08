import { kyivTime } from '../core/clock.js';
import { isKyivError } from '../kyiv/errors.js';
import type { Messages } from '../i18n/index.js';

/** User-facing text for an error from the Kyiv Digital client. Re-throws anything else. */
export function kyivErrorText(t: Messages, err: unknown): string {
  if (!isKyivError(err)) throw err;
  if (err.kind === 'rejected') return t.kyivError.rejected(err.details.serverMessage);
  if (err.kind === 'maintenance') return t.kyivError.maintenance(kyivTime(err.details.until ?? Date.now()));
  return t.kyivError[err.kind];
}

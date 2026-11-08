/** Icons by transport mode, as the feed names it (`title` of a `val_` event). */
const MODE_ICONS: [prefix: string, icon: string][] = [
  ['метро', '🚇'],
  ['автобус', '🚌'],
  ['тролейбус', '🚎'],
  ['трамвай', '🚋'],
  ['фунікулер', '🚠'],
  ['електричка', '🚆'],
  ['міська електричка', '🚆'],
];

/**
 * "🚇 Метро · Видубичі 1 (захід)" or "🚌 Автобус №87 · МАЗ 215-069". For the metro and the
 * funicular the place is a station; on buses, trolleybuses and trams it's often the vehicle.
 */
export function formatPlace(mode: string | null, place: string | null): string | undefined {
  if (!place) return undefined;
  const m = mode?.trim().toLowerCase() ?? '';
  const icon = MODE_ICONS.find(([prefix]) => m.startsWith(prefix))?.[1] ?? '📍';
  return mode ? `${icon} ${mode} · ${place}` : `${icon} ${place}`;
}

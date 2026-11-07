/** Places used when a validation doesn't specify one. Modes and stops as the feed shows them. */
export const STATIONS: { mode: string; place: string }[] = [
  { mode: 'Метро', place: 'Політехнічний інститут' },
  { mode: 'Метро', place: 'Хрещатик' },
  { mode: 'Метро', place: 'Лук’янівська' },
  { mode: 'Метро', place: 'Лівобережна' },
  { mode: 'Автобус', place: 'вул. Борщагівська' },
  { mode: 'Тролейбус', place: 'Площа Перемоги' },
  { mode: 'Трамвай', place: 'Контрактова площа' },
  { mode: 'Фунікулер', place: 'Поштова площа' },
];

export const STUDENT_CARD_ID = 1453674;
export const PUPIL_CARD_ID = 1453675;

/** Stable dev identity, so the bot's stored credentials survive mock restarts. */
export const DEV_DEVICE_UUID = '00000000-0000-4000-8000-000000000de1';
export const DEV_USER_ID = 4242;
/** 2030-01-01 — far enough not to trigger expiry warnings during normal dev. */
export const DEV_TOKEN_EXP_SEC = 1_893_456_000;

export type CardSeed = {
  id: number;
  name: string;
  type: number;
  code: string;
  trips: number;
};

export const DEFAULT_CARDS: CardSeed[] = [{ id: STUDENT_CARD_ID, name: 'Студентський', type: 2, code: '300003712345', trips: 36 }];

export const LABELS: Record<number, { text: string; color: string; bg_color: string; icon: string }> = {
  1: { text: 'Учнівський', color: '#00A86B', bg_color: '#E5F6EF', icon: 'https://kyiv.digital/i/qr/pupil.png' },
  2: { text: 'Студентський', color: '#008CFF', bg_color: '#E5F3FF', icon: 'https://kyiv.digital/i/qr/stud.png' },
};

export const QR_TEXTS = {
  title: 'Щоб оплатити проїзд, проскануйте QR-квиток на валідаторі.',
  link_text: 'Як сканувати квиток?',
  link_url: 'https://kyiv.digital/qr-how-to-use-video.html',
};

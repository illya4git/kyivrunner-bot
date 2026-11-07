import { z } from 'zod';

// Response schemas for the reverse-engineered API (docs/travel-cards.md).
// Only fields the bot relies on are required; everything else passes through untouched,
// so harmless additions on the server don't break us, but a changed core shape fails loudly.

const unix = z.number().int(); // seconds

export const CardSchema = z.looseObject({
  id: z.number().int(),
  name: z.string().nullable(),
  type: z.number().int(),
  code: z.string().nullable().optional(),
  locked_at: z.unknown().nullable().optional(),
  balance: z.number().nullable().optional(),
  balance_wallet: z.number().nullable().optional(),
  monthly_tickets: z
    .array(z.looseObject({ balance: z.number(), valid_from: unix, valid_to: unix }))
    .nullable()
    .optional(),
  monthly_tickets_balance: z.number().nullable().optional(),
  qrs_count: z.number().int().nullable().optional(),
  qr_generate_blocked: z.boolean().nullable().optional(),
  actions: z.looseObject({ generate_qr: z.boolean().optional() }).nullable().optional(),
});
export type Card = z.infer<typeof CardSchema>;

export const CardsResponseSchema = z.looseObject({
  qrs_total: z.number().int().optional(),
  cards: z.array(CardSchema),
});

export const CodeSchema = z.looseObject({
  id: z.number().int(),
  /** Raw QR payload. */
  code: z.string().min(1),
  type: z.number().int().optional(),
  card_id: z.number().int(),
  description: z.string().nullable().optional(),
  used_at: unix.nullable(),
  expire_at: unix,
  shared: z.boolean().optional(),
  qr_texts: z
    .looseObject({ label: z.looseObject({ text: z.string().optional() }).nullable().optional() })
    .nullable()
    .optional(),
});
export type Code = z.infer<typeof CodeSchema>;

export const CodesResponseSchema = z.looseObject({ codes: z.array(CodeSchema) });

export const FEED_EVENT_TYPE = { validation: 1, purchase: 2, qrCreated: 3, qrExpired: 4 } as const;

export const FeedEventSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  type: z.number().int(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  value_text: z.string().nullable().optional(),
  value_sum: z.number().nullable().optional(),
  created_at: unix,
});
export type FeedEvent = z.infer<typeof FeedEventSchema>;

export const FeedResponseSchema = z.looseObject({
  card: CardSchema.optional(),
  feed: z.looseObject({ data: z.array(FeedEventSchema) }),
});

// --- helpers on top of the raw shapes ------------------------------------------

/** Trips left on a monthly-ticket card. */
export function tripsLeft(card: Card): number {
  return card.monthly_tickets_balance ?? 0;
}

/** Generation precondition from docs §3. */
export function canGenerate(card: Card): boolean {
  return card.actions?.generate_qr === true && card.qr_generate_blocked !== true && !card.locked_at;
}

/** Usable = not validated and not expired (docs §5). `nowSec` in unix seconds. */
export function isUsable(code: Code, nowSec: number): boolean {
  return code.used_at === null && code.expire_at > nowSec;
}

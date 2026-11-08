# Travel cards & QR tickets

All endpoints are authenticated (Bearer token + [envelope](README.md#the-request-envelope-required-on-every-request))
and live under `https://kyiv.digital`. **No captcha / App Check** is required on this surface — the Bearer
token alone authorizes these calls (verified off-device).

## Endpoint summary
| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/v4/card/travel` | List all travel cards (+ balances). |
| GET  | `/api/v4/card/travel/{card_id}` | One card (same object as in the list). |
| GET  | `/api/v4/card/travel/{card_id}/feed` | Per-card trip / transaction history. |
| GET  | `/api/v4/card/travel/add` | Data for the "add card" screen. |
| POST | `/api/v4/card/travel/{card_id}/qr-ticket` | **Generate** a QR ticket (empty body). |
| GET  | `/api/v4/qr` | List all generated QR tickets (across cards). |

---

## 1. List cards — `GET /api/v4/card/travel`
Response:
```json
{ "qrs_total": 4, "cards": [ <CARD>, … ] }
```
- `qrs_total` — total generated QR tickets across all cards.
- `cards` — array of [CARD](#card-object).

Single card: `GET /api/v4/card/travel/{card_id}` returns one `CARD` with identical fields.

### CARD object
```json
{
  "id": 1453674,
  "name": "Студентський",
  "type": 2,
  "code": "3000037XXXXX",
  "locked_at": null,
  "balance": 0,
  "balance_wallet": 0,
  "monthly_tickets": [ { "balance": 36, "valid_from": 1793484000, "valid_to": 1796075999 } ],
  "monthly_tickets_balance": 36,
  "future_monthly_tickets_balance": 0,
  "monthly_ticket_purchase": { "available_month": 11, "half_a_month": false },
  "qrs_count": 5,
  "qr_generate_blocked": false,
  "qr_purchase_label": null,
  "actions": {
    "generate_qr": true, "generate_qr_always": false, "show_balance": true,
    "replenishment": true, "replenishment_wallet": true, "buy_monthly": true,
    "block": true, "replace": true, "rename": true,
    "show_info": false, "additional_order": false, "show_additional_order_status": false,
    "show_replace_status": false
  },
  "virtual_payload": { "info_fields": [ { "icon": "…", "title": "3000037XXXXX", "description": "Номер картки" } ],
                       "relink_price": 0, "virtual_tc_errors": null },
  "speed_dial": { "state": true, "another_tc_added": false },
  "info": null,
  "show_modal_delete": { "title": "…", "description": "…" }
}
```

| Field | Meaning |
|---|---|
| `id` | Travel card id (use in `/{card_id}` paths). |
| `name` | User-facing card name. |
| `type` | `1` = pupil (Учнівський), `2` = student (Студентський). Other types exist for other card classes. |
| `code` | Physical card number. |
| `locked_at` / `qr_generate_blocked` | If set / `true`, the card is blocked (no generation). |
| `balance` | Money/trip balance (non-monthly cards; fare deducted per trip). |
| `balance_wallet` | Separate wallet balance (UAH). |
| `monthly_tickets[]` | Active monthly-ticket bundles: `balance` (tickets left), `valid_from`/`valid_to` (unix window). |
| `monthly_tickets_balance` | **Trips left** for monthly-ticket cards (see [ticket mechanics](#ticket-mechanics)). |
| `qrs_count` | Generated QR tickets currently on this card. |
| `actions.generate_qr` | Whether QR generation is allowed (precondition for generate). |

---

## 2. Trips / balance left
Read directly from the `CARD`:
- **Monthly-ticket cards** (e.g. student): `monthly_tickets_balance` (and per-bundle `monthly_tickets[].balance` with validity window).
- **Money / wallet cards**: `balance` / `balance_wallet` — fare is deducted per trip.
- `qrs_count` — how many QR tickets already exist on the card.

---

## 3. Generate a QR ticket — `POST /api/v4/card/travel/{card_id}/qr-ticket`
- **Body:** *empty* (zero-length). **Do not** send `Content-Type`. No captcha / `X-ReCaptcha-Token` needed.
- **Precondition:** `CARD.actions.generate_qr == true` **and** `CARD.qr_generate_blocked == false`.
- **Response (200):** `{ "codes": [ <CODE>, … ] }` — same shape as `GET /api/v4/qr`, with the **new ticket prepended**.

```http
POST /api/v4/card/travel/1453674/qr-ticket HTTP/2
Authorization: Bearer <token>
X-Client-Auth: <KYIV_CLIENT_AUTH>
X-Device-UUID: <uuid>
(no body)
```
Response (new code is `codes[0]`):
```json
{ "codes": [
  { "id": 230270218, "code": "$$XXXXXXXXXX", "type": 1, "card_id": 1453674,
    "description": "Дійсний до опівночі", "used_at": null, "expire_at": 1793915999,
    "shared": false, "qr_texts": { "label": { "text": "Студентський", "…": "…" }, "…": "…" } },
  … ] }
```

### Ticket mechanics
(Confirmed with the account owner.)
- Each **generation reserves one ticket** from `monthly_tickets_balance` (observed `37 → 36` on one generate).
- An **unused** ticket (not validated by midnight) **returns to the balance at midnight**. So a day you don't
  ride costs nothing even if you generated; a day you ride costs one ticket regardless of how many times you regenerated.
- Monthly tickets are **nullified at the start of a new month** (unused balance does not roll over).
- The QR itself is a **day pass** (`description: "Дійсний до опівночі"` = valid until midnight; `expire_at` = end of day).

---

## 4. Fetch generated tickets (contents + status) — `GET /api/v4/qr`
Response:
```json
{ "codes": [ <CODE>, … ],
  "version": 102,
  "active_qr_texts": { "title": "…", "link_text": "…", "link_url": "…" },
  "used_qr_texts": { "…": "…" } }
```

### CODE object (a QR ticket)
```json
{
  "id": 230270218,
  "code": "$$XXXXXXXXXX",
  "type": 1,
  "card_id": 1453674,
  "card_type": null,
  "name": null,
  "description": "Дійсний до опівночі",
  "icon_url": null,
  "shared": false,
  "shared_at": null,
  "used_at": null,
  "expire_at": 1793915999,
  "qr_texts": {
    "title": "Щоб оплатити проїзд, проскануйте QR-квиток на валідаторі.",
    "link_text": "Як сканувати квиток?",
    "link_url": "https://kyiv.digital/qr-how-to-use-video.html",
    "label": { "color": "#008CFF", "bg_color": "#E5F3FF", "text": "Студентський", "icon": "https://kyiv.digital/i/qr/stud.png" }
  }
}
```

| Field | Meaning |
|---|---|
| `id` | Ticket id. |
| `code` | **The raw QR payload** — the string to encode into the QR image (e.g. `"$$XXXXXXXXXX"`). |
| `card_id` | Owning travel card. |
| `used_at` | `null` = not yet validated; unix timestamp once scanned/validated. **This is the status.** |
| `expire_at` | Unix expiry (end of the day the ticket is valid for). |
| `shared` / `shared_at` | Whether the code was shared. |
| `qr_texts.label.text` | Card class label shown under the QR. |
| `card_type`, `name`, `icon_url` | Seen as `null`. |

### Timing and which codes are listed (observed on the live API, 2026-11-07/08)
- **`used_at` appears late.** A scan shows up in `/qr` **1–8 minutes** after it happened, with
  `used_at` set back to the actual scan time. Poll for it; don't expect it the moment the rider
  passes the gate.
- **The list holds only today's codes.** Unused codes vanish once they expire at midnight.
- **A used code drops out about 2 hours after the scan** (one code was listed 1 h 26 min after its
  scan and gone at 2 h 02 min; another was gone at 3.8 h). A client that wasn't polling then can't read `used_at`
  any more. If a code it issued is missing **before** its `expire_at`, it was used; take the time
  and place from the feed (§6).

**Rendering:** the QR image is produced **client-side** from `code` — there is no server endpoint that
returns the QR bitmap for a ticket. Encode `code` as a QR (the validator scans that string).

---

## 5. Are there usable tickets already?
From `GET /api/v4/qr`, a ticket is **usable** when:
```
used_at == null  AND  expire_at > now()   (for the target card_id)
```
Cheap existence pre-check without the full list: `CARD.qrs_count > 0` (per card) or `qrs_total` (all cards).
If none are usable and `actions.generate_qr == true`, generate one (§3).

---

## 6. Trip / usage history — where & when a ticket was spent
`GET /api/v4/card/travel/{card_id}/feed?page=1&per_page=30` (paginated).
Response: `{ "card": <CARD>, "feed": { "data": [ <EVENT>, … ] } }`.

### EVENT object
Keys: `id, type, icon, sub_icon, title, description, value_sum, value_text, passengers, rating, read, clickable, created_at`.
The event kind is given by `type` (and mirrored in the `id` prefix):

| `type` | `id` prefix | Meaning | `title` | `description` | `value_text` | `value_sum` |
|---|---|---|---|---|---|---|
| **1** | **`val_`** | **Trip validated (ticket SPENT)** | transport mode (`Метро`, `Автобус`, …) | **location** — station/stop name (e.g. `Політехнічний інститут`) | validation time `HH:MM` | — |
| 2 | `pch_` | Card replenishment / purchase | `Поповнення карти` | what was bought (e.g. monthly pass, 46 trips) | — | amount in **kopiykas** (`54400` = 544.00 UAH) |
| 3 | `qrt_` | QR ticket created | `Ви створили QR-квиток` | — | — | — |
| 4 | `eqr_` | QR expired, trip returned to card | `Сплив термін QR-квитка` | `Поїздка повернулася на карту` | — | — |

`created_at` is the unix timestamp of every event.

More detail on the event kinds (observed on the live API):
- **`val_` (validation):** for the metro (and the funicular) `title` is `Метро` and `description` the
  station gate, e.g. `Видубичі 1 (захід)`. On **buses, trolleybuses and trams** `title` includes the
  route (`Автобус №87`, `Тролейбус №38`) and `description` is often the **vehicle**, not a stop:
  the model and board number (`МАЗ 215-069`, `Mercedes 0530 Citaro`) or just the number (`Т90110`).
  Trams may name the stop (`Станція «Старовокзальна» 2`). `value_text` is `HH:MM` in Kyiv time.
  The numeric part of the id is assigned when the validation **reaches the server**, so ids are not
  in scan order (e.g. a scan at 21:20:00 has a lower id than one at 21:19:56).
- **`qrt_<code id>`:** the suffix is the CODE `id` from §4, so a client can tell its own codes apart.
- **`eqr_<unix time>`:** one event per expiry batch at 23:59:59 Kyiv time, e.g.
  `Сплив термін 4 QR-квитків` / `Поїздки повернулися на карту` for four codes at once.
- `feed.meta` holds pagination info. The feed lists every validation on the card: QR codes, the
  physical card, and codes generated in the phone app.

### Getting "where & when a QR was spent"
- **When** a given code was used → the code's `used_at` from `GET /api/v4/qr` (§4).
- **Where + when** the trip happened → the **`type:1` / `val_`** feed events:
  `description` = station or vehicle (**no GPS coordinates**), `title` = mode (and route), `created_at` / `value_text` = time.
- A `val_` event does **not** carry the code id it consumed. To link a code to its validation,
  **match the code's `used_at` to a `val_` event's `created_at`: they are equal to the second**
  (verified on two live scans). Two codes can be scanned seconds apart at the same gate, so take the
  closest event and never assign one event to two codes.
- **Validations reach the feed late,** after they reach `/qr`; how late isn't measured yet. In one
  session none of four validations was in the feed about 1 minute after `/qr` reported the code as
  used, and all of them were there hours later. Keep looking for a while (the bot searches from
  5 minutes after the scan, every 30 s for the first 15 minutes, then every 5 minutes, for up to
  6 hours).
- For a code that dropped out of `/qr` before the client saw it used (§4), take the earliest
  unclaimed `val_` event between the code's creation and the moment it went missing.

> Note: the per-card `info` block (on `/feed`, for pupil/school cards) may include personal data
> (holder full name, photo URL, school, PIN). Treat the feed response as sensitive.

## Other authenticated endpoints (context, read-only)
Seen alongside the above; not central to QR tickets:
`GET /api/v3/user/profile`, `/api/v4/feed?page=&per_page=` (global activity feed; returned `503` during capture),
`/api/v4/headline`, `/api/v4/dtek/all`, `/api/v4/offline-maps/mmpk`.

# Kyiv Digital API — Auth & Travel Cards (reverse-engineered reference)

Reverse-engineered documentation of the **Kyiv Digital** (`com.kyivdigital`, Android app v4.0.0,
versionCode 912) backend, scoped to **authentication** and **travel-card / QR-ticket** actions.
Derived from static decompilation of the APK and from live HTTPS captures of the app on a rooted
device, plus off-device replay from a plain HTTP client. Intended audience: humans and agents
building an **alternative QR-ticket client** for a *single, personal account*.

> ⚠️ **Scope & intent.** This documents a personal-use, single-account client (check balances,
> check/generate your own transit QR tickets). The login reCAPTCHA, the static client header, and
> the rate limits are anti-abuse controls — respect them. Do not use this for multi-account or
> high-volume automation. Treat all tokens as live credentials (full account access).

## Documents
- **[authentication.md](authentication.md)** — login (phone → captcha → OTP), token, refresh, logout.
- **[travel-cards.md](travel-cards.md)** — list cards, balances/trips, QR tickets, generate, data models.
- **[building-a-qr-client.md](building-a-qr-client.md)** — end-to-end recipe for a QR-ticket client, using a **token extracted from the app** (the app handles login/refresh/captcha).

## Base URL & transport
- **Base URL:** `https://kyiv.digital`
- **Transport:** HTTPS, HTTP/2. Fronted by **Cloudflare** (`server: cloudflare`, `cf-ray`, sets `__cf_bm` cookie).
- **No certificate pinning** in the app — a standard TLS client works; no TLS/JA3 impersonation needed (verified with `curl`).
- **Static asset / CDN host:** `https://static.kyiv.digital` (offline maps, images — not covered here).

## The request envelope (REQUIRED on every request)
Every API call carries this header set (built by the app's OkHttp interceptor). Missing/!wrong
`X-Client-Auth` or a stale version can be rejected.

| Header | Value | Notes |
|---|---|---|
| `Authorization` | `Bearer <access_token>` | Empty (`Bearer `) while unauthenticated (guest). |
| `Accept` | `application/json` | |
| `X-Client-Auth` | `<KYIV_CLIENT_AUTH>` (not published) | **Static** 32-byte secret, baked into the APK, identical for all installs. A gate header, not per-user. |
| `X-Client-Version` | `4.0.0` | App version. Keep current; see `min_version` in the token response. |
| `X-Client-Platform` | `0` | `0` = Android (observed). |
| `X-Client-Locale` | `uk` | UI language (`uk`/`en`). |
| `X-Client-Theme` | `1` | `1` = dark, `0` = light. Cosmetic. |
| `X-Device-UUID` | `<uuid-v4>` | **Stable** per install — generate once, persist, never rotate. |
| `User-Agent` | `KD/4.0.0 Android/11 User/<guest\|userId>` | Encodes app version, platform, OS, and auth state. |
| `Content-Type` | `application/json; charset=UTF-8` | On JSON-body requests only. **Omit for empty-body POSTs** (e.g. generate QR). |

Challenge-only headers (added on a login retry — see authentication.md):
`X-ReCaptcha-Token` **or** `X-Firebase-AppCheck`.

## Authentication state
- Obtain an **`access_token`** (JWT) either by **extracting it from the app** (recommended for a personal
  client — see [building-a-qr-client.md](building-a-qr-client.md#obtaining-the-token-by-extraction)) or by
  scripting the full login flow ([authentication.md](authentication.md)).
- Send it as `Authorization: Bearer <token>` on every authenticated call.
- Lifetime **≈186 days** (`expires_in: 16070400`). Renew via `/api/v3/auth/refresh` before expiry.
- Empirically, the **authenticated API surface is gated by the Bearer token alone** — no captcha or
  App Check on authenticated reads/writes (confirmed on a device that fails Play Integrity and from
  an off-device client). Only **login** is challenge-gated.

## Error / status conventions
| Status | Meaning | Handling |
|---|---|---|
| `200` | OK | Parse JSON body. |
| `423 Locked` | **Challenge required** (login). Body: `{"message":"Error","recaptcha_link":"…"}` | Solve reCAPTCHA (or supply App Check), retry with the challenge header. |
| `401` | Token invalid/expired | Re-auth or refresh. |
| `429` | Rate limited | Back off. See rate limits. |
| `503` | Transient upstream | Retry with backoff (seen intermittently on `/feed`). |

## Rate limits
- `X-RateLimit-Limit: 60`, `X-RateLimit-Remaining: <n>` headers on responses → **60 requests/minute** per token.
- Keep volume human-paced; bursts increase the chance of a Cloudflare / risk-engine challenge.

## Operational notes for an off-device client
- Use a **stable `X-Device-UUID`** (one identity) and the **full header envelope**, identically across runs.
- Prefer a **residential Ukrainian IP** (ideally the account's usual network). Datacenter/VPN egress is a risk flag.
- You **cannot mint `X-Firebase-AppCheck`** off-device (it needs Play Integrity on a genuine device), so the
  only challenge path available to you is the **human reCAPTCHA** at login. Authenticated calls don't need it.
- Token renewal (`/auth/refresh`) is **not yet verified** — see authentication.md.

## Glossary
- **access_token** — the JWT bearer credential (tymon/jwt-auth, ES256).
- **card** — a travel card (student/pupil/etc.) linked to the account.
- **QR ticket / code** — a generated, validator-scannable transit ticket (`code` = the raw QR payload string).
- **challenge** — the server demanding proof-of-humanity/attestation (reCAPTCHA or App Check).

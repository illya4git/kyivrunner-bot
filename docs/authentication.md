# Authentication

Phone-number + SMS-OTP login, gated by a Google reCAPTCHA challenge, returning a long-lived JWT.
All requests use the [request envelope](README.md#the-request-envelope-required-on-every-request).

## Overview of the flow
```
1. POST /api/v4/login        {phone}                      -> 423 + recaptcha_link   (challenge required)
2. (solve reCAPTCHA in a webview/browser) -> reCAPTCHA token
3. POST /api/v4/login        {phone}  + X-ReCaptcha-Token -> 200 (SMS OTP sent)
4. POST /api/v4/login/verify {phone, code, device{…}}     -> 200 {token, profile}
   -> store token.access_token  (valid ~186 days)
```
The on-device app can alternatively satisfy step 2 silently with a **Firebase App Check** token
(`X-Firebase-AppCheck`) backed by Play Integrity. **Off-device clients cannot** produce App Check and
must use the human reCAPTCHA path.

---

## 1. Request OTP — `POST /api/v4/login`
Request body:
```json
{ "phone": "+380XXXXXXXXX" }
```
Headers: standard envelope with `Authorization: Bearer ` (empty) and `Content-Type: application/json`.

### First call → challenge (HTTP 423)
Without a challenge header the server responds:
```json
{ "message": "Error",
  "recaptcha_link": "https://kyiv.digital/recaptcha?c=<laravel-encrypted-blob>" }
```
- `423 Locked` signals **challenge required**.
- `recaptcha_link` is a one-time page; the `?c=` value is a Laravel `encrypt()` blob (iv/value/mac/tag)
  binding the challenge to this phone/session. **Fetch a fresh link each attempt** — do not reuse.

### Retry with the challenge token → HTTP 200
Resend the identical body **plus** the header `X-ReCaptcha-Token: <token>` (see [§reCAPTCHA](#recaptcha-mechanics)).
Response:
```json
{ "success": true,
  "retry_after": 60,
  "method": 0,
  "available_alternative_method": true }
```
- `method: 0` → OTP delivered by **SMS**. `available_alternative_method: true` → a fallback channel exists (e.g. voice).
- `retry_after` → seconds before another OTP request is allowed.
- An SMS with the numeric code is then sent to the phone.

---

## 2. Verify OTP — `POST /api/v4/login/verify`
Request body:
```json
{
  "phone": "+380XXXXXXXXX",
  "code": "NNNN",
  "device": {
    "uuid": "<same uuid as X-Device-UUID>",
    "platform": "0",
    "app_ver": "4.0.0",
    "os_ver": "11",
    "name": "<device model string>",
    "fcm_token": "<Firebase push token, may be empty for a non-push client>",
    "screen_width": "1080",
    "screen_height": "1962"
  }
}
```
Headers: standard envelope, `Content-Type: application/json`. No challenge header needed here.

Response (HTTP 200):
```json
{
  "token": { "access_token": "<JWT>", "token_type": "bearer", "expires_in": 16070400 },
  "min_version": "2.12",
  "profile": { "id": 0, "first_name": "…", "last_name": "…", "bankid_connected": true,
               "emails": [{"type":"USER","email":"…"}],
               "phones": [{"type":"PRIMARY","phone":"+380XXXXXXXXX"}], "…": "…" }
}
```
- Persist `token.access_token`. Use it as `Authorization: Bearer <access_token>` thereafter.
- `min_version` is the lowest app version the server accepts — keep `X-Client-Version` ≥ this.
- `profile` is the same shape returned by `GET /api/v3/user/profile`.

### The access token
- Format: **JWT**, `alg: ES256` (tymon/jwt-auth). The client treats it as opaque — just carry it.
- Claims: `iss` (=`…/api/v4/login/verify`), `iat`, `nbf`, `exp` (≈ iat + 186 days), `jti`, `sub` (user id), `prv`, `d` (device id).
- `expires_in: 16070400` s = **186 days**. Plan renewal before `exp`.

---

## 3. Refresh — `POST /api/v3/auth/refresh`  *(NOT YET VERIFIED)*
Present in the app but **not exercised** in captures. Known from static analysis:
- Request body: a device/login object (same DTO family as login — likely `{device{…}}`, possibly `{phone, device}`).
- Response: wraps a **new token** (same `{access_token, token_type, expires_in}` shape).
- Expected to be an authenticated, token-for-token swap needing only the current Bearer (no SMS, no captcha),
  because it carries a valid session and sends no OTP. **Confirm by capturing one** before relying on it.
- Caveat: the challenge interceptor is global, so the server *could* return `423` here; not observed, but possible.

## 4. Logout — `POST /api/v3/auth/logout`
Authenticated, empty body → invalidates the session server-side. Response is a generic success envelope.

---

## reCAPTCHA mechanics
The `recaptcha_link` page hosts **Google reCAPTCHA v2** (checkbox).

- **Site key:** `6Ld578kcAAAAAK6HfcPS8WTz9mWuzEQgG3MG0HlY`
- On success the page returns the token by calling a **JavaScript bridge**, not a redirect:
  ```js
  if (window.recaptcha && window.recaptcha.postMessage) { window.recaptcha.postMessage(<token>); }
  ```
  The app binds this via `WebView.addJavascriptInterface(obj, "recaptcha")`, where `obj` exposes
  `@JavascriptInterface void postMessage(String token)`.
- The returned token is sent on the `/login` retry as **`X-ReCaptcha-Token: <token>`**. It is a standard
  Google reCAPTCHA response — **single-use, ~2 min TTL** — so use it immediately.

### Capturing the token outside the app
A *bare* webview is **not** enough (no `window.recaptcha` ⇒ the token goes nowhere). You need one of:
1. **Replicate the bridge** — inject a JS object named `recaptcha` with a `postMessage(String)` method
   (Android `WebView`), or in a desktop browser define `window.recaptcha = { postMessage: v => capture(v) }`
   before load. A human solves the checkbox; your hook captures the token.
2. **Read the standard reCAPTCHA output** after the human solves: `grecaptcha.getResponse()` or the value of
   `document.getElementById('g-recaptcha-response')`. Same token.

Example (headful Playwright): see [building-a-qr-client.md](building-a-qr-client.md#one-time-bootstrap-login).

> Because off-device clients can't use App Check, **every fresh login needs one human captcha solve**.
> With the ~186-day token this is roughly twice a year. Everything after login is headless.

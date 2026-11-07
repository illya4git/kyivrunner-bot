# Building an alternative QR-ticket client (extracted-token approach)

A practical recipe for a personal, headless client that checks balances and obtains a usable transit
QR ticket. It **reuses a token extracted from the real app** instead of re-implementing login — so the
app keeps doing the hard parts (reCAPTCHA, App Check, SMS OTP, and token refresh) and your client just
carries the current token. Combines [travel-cards.md](travel-cards.md); see
[authentication.md](authentication.md) if you ever want to script the full login instead.

> **Single-account, personal use only.** See the scope note in [README.md](README.md).

## Architecture
```
in the REAL app (you don't automate this):  login + periodic refresh  ──► current access_token
one-time / when it expires:                 EXTRACT token (+ device uuid) from the app
every run, headless:                         token ──► list / qr / generate ──► render QR
```
- No captcha, no App Check, no Playwright, no SMS handling in your client.
- The app refreshes its own token (~186-day life); you **re-extract** when yours stops working.

## Prerequisites
- A way to **extract the token** from the app (see below): a proxied capture, or a rooted device's prefs.
- The full [request envelope](README.md#the-request-envelope-required-on-every-request) incl. the static `X-Client-Auth`.
- The **`X-Device-UUID`** that the source app uses — extract it alongside the token and reuse it (keep identity consistent).
- Network egress from a **residential Ukrainian IP** (recommended; avoids risk-engine flags).
- Secure storage for the extracted `access_token` (full account access).

---

## Obtaining the token by extraction
You need two values, taken from the **same** app install so they match: the `access_token` and the
`X-Device-UUID`. Pick either method.

### Method A — from a proxied capture (most reliable)
Route the app's traffic through an intercepting proxy once and read the headers off any authenticated
request (e.g. `GET /api/v3/user/profile`). This is exactly how this client's values were obtained.

High-level steps (see `analysis/notes/DYNAMIC-SETUP.md` for the full rig):
1. Install the proxy CA as a **system** CA on a rooted device/emulator (the app uses the system trust
   store; **no cert pinning**, so no Frida needed).
2. Point the device at the proxy (e.g. `mitmdump` + `adb reverse tcp:8080 tcp:8080` + global `http_proxy`).
3. Open the app (already logged in) and let it make any authenticated call.
4. Read `Authorization` and `X-Device-UUID` from that request.

Programmatic read from a saved `mitmproxy` flow file:
```python
# pip install mitmproxy ; run with the mitmproxy venv's python
from mitmproxy import io, http

def extract_from_flows(path):
    want = {"authorization", "x-device-uuid"}
    with open(path, "rb") as f:
        for fl in io.FlowReader(f).stream():
            if isinstance(fl, http.HTTPFlow) and "/api/" in fl.request.path:
                a = fl.request.headers.get("authorization", "")
                if a.startswith("Bearer ") and len(a) > 20:
                    return {"access_token": a[len("Bearer "):],
                            "device_uuid": fl.request.headers.get("x-device-uuid", "")}
    raise SystemExit("no authenticated request found in capture")
```
(Or just copy the `Authorization` value out of mitmweb / Charles / Proxyman by hand.)

### Method B — from a rooted device's app storage
The app stores the token in **plaintext SharedPreferences** (no Keystore/encryption). On a rooted device:
```bash
# find the JWT in the app's shared_prefs
adb shell su -c "grep -ro 'eyJ[A-Za-z0-9_-]\\{10,\\}\\.' /data/data/com.kyivdigital/shared_prefs/ | head"
# and the device uuid the app uses
adb shell su -c "grep -rho '[0-9a-f]\\{8\\}-[0-9a-f]\\{4\\}-[0-9a-f]\\{4\\}-[0-9a-f]\\{4\\}-[0-9a-f]\\{12\\}' /data/data/com.kyivdigital/shared_prefs/ | head"
```
Pull the full JWT (three dot-separated segments) from the matching `shared_prefs/*.xml`.

> Whichever method: the token is the app's **live** token. If the app later refreshes (gets a new token),
> your copy keeps working until its own `exp`, but to stay in sync long-term, re-extract periodically.

---

## The envelope in code
```python
import requests

BASE = "https://kyiv.digital"
ACCESS_TOKEN = "PASTE-EXTRACTED-TOKEN"          # from extraction
DEVICE_UUID  = "PASTE-EXTRACTED-DEVICE-UUID"    # from the SAME app install

def headers(extra: dict | None = None) -> dict:
    h = {
        "Authorization": f"Bearer {ACCESS_TOKEN}",
        "Accept": "application/json",
        "X-Client-Auth": "<KYIV_CLIENT_AUTH>",
        "X-Client-Version": "4.0.0",
        "X-Client-Platform": "0",
        "X-Client-Locale": "uk",
        "X-Client-Theme": "1",
        "X-Device-UUID": DEVICE_UUID,
        "User-Agent": "KD/4.0.0 Android/11 User/me",
    }
    if extra: h.update(extra)
    return h
```

## Headless operations (every run)

### List cards & balances
```python
def list_cards():
    return requests.get(f"{BASE}/api/v4/card/travel", headers=headers(), timeout=15).json()

def trips_left(card):   # monthly-ticket cards
    return card.get("monthly_tickets_balance", 0)
```

### Get a usable QR ticket (reuse if possible, else generate)
```python
import time

def get_usable_ticket(card_id):
    now = int(time.time())
    qr = requests.get(f"{BASE}/api/v4/qr", headers=headers(), timeout=15).json()
    for t in qr["codes"]:
        if t["card_id"] == card_id and t["used_at"] is None and t["expire_at"] > now:
            return t                      # already usable -> reuse, no ticket reserved
    # none usable -> generate (empty body, NO Content-Type)
    gen = requests.post(f"{BASE}/api/v4/card/travel/{card_id}/qr-ticket",
                        headers=headers(), timeout=15).json()
    return gen["codes"][0]                # newest is first
```
Reusing an existing unused code avoids reserving another ticket. (Reserved-but-unused tickets return to
the balance at midnight; monthly tickets are nullified at month start — see ticket mechanics.)

### Render the QR
The ticket's `code` (e.g. `"$$XXXXXXXXXX"`) **is** the QR payload — encode it directly:
```python
import qrcode
def render(ticket, path="ticket.png"):
    qrcode.make(ticket["code"]).save(path)      # scan this at the validator
```

### End-to-end
```python
cards = list_cards()["cards"]
card  = next(c for c in cards if c["type"] == 2)   # e.g. the student card
print("trips left:", trips_left(card))
ticket = get_usable_ticket(card["id"])
render(ticket)
print("ticket:", ticket["code"], "expires", ticket["expire_at"], "used:", ticket["used_at"])
```

## Token lifecycle (extraction model)
- You do **not** implement refresh or login. Let the app do both.
- On a `401` (or if calls stop working), the token is stale → **re-extract** the current token from the app.
- Optional: decode the JWT `exp` claim to know when to re-extract proactively (lifetime ~186 days from issue).
- If you prefer self-contained auth (script the login + refresh yourself), use [authentication.md](authentication.md) instead.

## Pitfalls / gotchas
- **Match token ↔ device uuid**: extract both from the same install and keep them paired; don't mix a token
  with a different `X-Device-UUID`.
- **Empty-body POST** for generate: send no body and **no `Content-Type`** (matches the app).
- **Stable identity**: keep the envelope identical across runs; don't rotate `X-Device-UUID`.
- **Rate limit 60/min** per token (`X-RateLimit-*` headers). Pace requests; avoid bursts.
- **Residential IP**: datacenter/VPN egress is a risk flag.
- **No App Check off-device**: observed today, only *login* is challenge-gated; reads and QR generation are
  Bearer-only. Payment/replenishment endpoints (not covered here) are the most likely place attestation
  could be added later.
- **Keep `X-Client-Version` ≥ `min_version`** from the token response (was `2.12`).

## Verification status (what's observed vs inferred)
| Item | Status |
|---|---|
| Header envelope incl. static `X-Client-Auth` | **Observed** (identical on the wire & in the APK). |
| Token extraction from a proxied capture | **Observed** (used to drive this client). |
| Token extraction from plaintext SharedPreferences | **Inferred** from static analysis (app stores it unencrypted); key name not pinned. |
| List cards / balances, `/api/v4/qr`, generate QR | **Observed** on-device **and** off-device (plain `curl`, residential IP, HTTP 200). |
| Ticket mechanics (reserve, midnight return, monthly nullify) | **Confirmed with account owner.** |
| App refreshing its own token (so re-extraction stays viable) | **Inferred** (app has refresh logic; not captured). |

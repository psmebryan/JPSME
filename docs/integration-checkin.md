# Scanning JPSME event tickets from another system

For the developer of the system that will do the scanning.

## The one thing to understand first

A JPSME QR code contains **only a random number**:

```
PSME-EVENT:9f2c4a1e……   (a fixed prefix, then 64 hex characters)
```

There is no name in it, no email, no event, no ID. It is a credential, not a
record. Scanning one tells you nothing by itself — you have to ask the JPSME
server who it belongs to.

That is deliberate. It means a photographed or shared ticket leaks no personal
data, and a ticket can be cancelled or reissued without the code itself needing
to change meaning.

So the integration is: **scan → send the string to JPSME → get back who it is
and whether they may come in.**

## What you'll be given

An integration key, which looks like this:

```
jpsme_ik_4f2a91b0c3d8_7e1f……
```

Two things to know about it:

- **It is tied to one event.** You never send an event ID. The key already
  knows which event it opens, so there is nothing to configure per event and
  nothing to get wrong.
- **It is shown once.** JPSME stores only a hash of it. If it's lost it has to
  be revoked and reissued — there is no "show me the key again".

Treat it like a password: keep it on your server, not in a mobile app or
browser page you ship to users. Anyone holding it can check people in.

## Base URL

```
https://<jpsme-host>/api/integration
```

Send the key on every request:

```
Authorization: Bearer jpsme_ik_4f2a91b0c3d8_7e1f……
```

There is **no CSRF token and no cookie**. This is a server-to-server API.

## The endpoints

| | |
|---|---|
| `GET /whoami` | Which event this key opens. Call once, at setup. |
| `GET /registrations` | The roster for that event. Paginated and searchable. |
| `POST /checkin` | Admit somebody by their scanned QR. |
| `POST /checkin/manual` | Admit somebody by registration number, when the QR won't scan. |
| `POST /lookup` | Identify somebody **without** admitting them. |

---

## 1. Confirm your setup — `GET /whoami`

Call this once when you're wiring things up, **before** the day of the event.
It tells you which event your key opens, so a key pasted from the wrong email
is caught in advance rather than at the door with a queue behind it.

```bash
curl https://<jpsme-host>/api/integration/whoami \
  -H "Authorization: Bearer $JPSME_KEY"
```

```json
{
  "success": true,
  "message": "Integration key is valid",
  "data": {
    "event": { "id": 12, "title": "National Convention 2026", "startDate": "2026-11-04T01:00:00.000Z" },
    "key":   { "keyId": "4f2a91b0c3d8", "label": "Gate system — main lobby" }
  }
}
```

## 2. Get the registration list — `GET /registrations`

Everybody registered for your key's event. Use it to pre-load names, power a
search box, show a headcount, or reconcile afterwards.

```bash
curl "https://<jpsme-host>/api/integration/registrations?page=1&pageSize=200" \
  -H "Authorization: Bearer $JPSME_KEY"
```

```json
{
  "success": true,
  "data": {
    "eventId": 12,
    "total": 438,
    "page": 1,
    "pageSize": 200,
    "pageCount": 3,
    "registrations": [
      {
        "id": 901,
        "registrationNumber": "REG-2026-000123",
        "fullName": "Ana Reyes",
        "organizationPath": "JPSME National › Luzon › Cavite Chapter",
        "status": "REGISTERED",
        "checkedInAt": null
      }
    ]
  }
}
```

| query param | notes |
|---|---|
| `page`, `pageSize` | `pageSize` max 500, default 100. Loop while `page <= pageCount`. |
| `q` | Matches name, registration number or email. 2 characters minimum. |
| `status` | `REGISTERED`, `PENDING_PAYMENT` or `CANCELLED`. **Default returns the first two** — the people who can actually be admitted. |
| `checkedIn` | `true` or `false`. Omit for both. |

### There is no `qrToken` in this response, and there never will be

This is the one thing to understand about the roster. A `qrToken` is **not an
identifier — it is the credential that admits somebody.** A list of tokens is a
list of working tickets: anyone who obtained the file could generate a valid QR
for every attendee, and every one would stay valid until individually reissued.

You don't need them. At the door you read a token off the ticket in front of
you and send that. For everything else — searching, displaying, matching your
records to JPSME's — use `registrationNumber`. It's printed on the ticket, safe
to store, and admits nobody on its own.

`email` and `phone` are absent for a related reason: a roster pulled into
another system is a copy of members' personal data, so it carries what a door
needs to identify somebody and nothing more.

## 3. Check someone in — `POST /checkin`

This is the main call. It records the attendance **in JPSME**, so both systems
agree on who arrived.

```bash
curl -X POST https://<jpsme-host>/api/integration/checkin \
  -H "Authorization: Bearer $JPSME_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "qrToken": "PSME-EVENT:9f2c4a1e……", "station": "Lobby 1" }'
```

| field | required | notes |
|---|---|---|
| `qrToken` | yes | Whatever the scanner read. Send it **unchanged** — don't strip the prefix, trim, or upper-case it. JPSME parses it. |
| `station` | no | Free text naming this lane or device, e.g. `"Lobby 1"`. Shows up in JPSME's door log so scans can be traced back to a physical point. |

```json
{
  "success": true,
  "message": "Checked in.",
  "data": {
    "ok": true,
    "result": "SUCCESS",
    "participant": {
      "name": "Juan dela Cruz",
      "registrationNumber": "REG-2026-000123",
      "organizationPath": "JPSME National › Luzon › Cavite Chapter"
    },
    "checkedInAt": "2026-11-04T01:12:44.000Z"
  }
}
```

### Read `result`, not the HTTP status

**A refused scan comes back as HTTP 200 with `ok: false`.** Being turned away at
a door is a normal outcome, not a failed request — if you branch on the status
code you'll show a "network error" screen to someone whose ticket was simply
already used.

| `result` | what happened | suggested handling |
|---|---|---|
| `SUCCESS` | Admitted just now | Green. Show the name. |
| `ALREADY_CHECKED_IN` | Valid ticket, already used | Amber. `checkedInAt` says when. Usually a double-scan; occasionally a shared ticket, so show the name and let staff judge. |
| `INVALID_QR` | Not a JPSME ticket, or not a real one | Red. `participant` is `null` — there is nobody to name. |
| `WRONG_EVENT` | A real JPSME ticket, for a different event | Red. Names the person so staff can redirect them. |
| `CANCELLED` | The registration was cancelled | Red. |
| `UNPAID` | Payment not confirmed | Red. Send them to the desk, not away. |
| `NOT_REGISTERED` | Not in a state that admits | Red. |
| `REJECTED` | The account behind it was rejected | Red. |

Genuine faults are still real HTTP errors: **401** (bad, revoked or missing
key), **422** (malformed body), **429** (rate limited), **5xx**.

## 4. Check in someone without a scannable code — `POST /checkin/manual`

A lost phone, a dead battery, a torn printout. Find them with
`GET /registrations?q=…`, then:

```bash
curl -X POST https://<jpsme-host>/api/integration/checkin/manual \
  -H "Authorization: Bearer $JPSME_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "registrationNumber": "REG-2026-000123", "station": "Help desk" }'
```

Send either `registrationNumber` or `registrationId` (both come from the
roster). The response is identical to `/checkin`, and so are the rules: an
unpaid or cancelled registration is refused here exactly as it would be at the
QR reader. JPSME records it as a manual check-in rather than a scan, so the two
stay distinguishable in reporting.

## 5. Identify without admitting — `POST /lookup`

Same request shape as `/checkin`, same response shape, but it **writes
nothing** — no check-in, and no entry in the door log.

Use it when you need to know who someone is without claiming they arrived:
printing a badge, showing a name on a screen, directing them to a lane. If you
call `lookup` and then `checkin`, only the `checkin` counts as an arrival.

---

## Things worth getting right

**Send the scanned string unmodified.** Some scanners append a newline or a Tab;
JPSME handles that. Your own trimming is more likely to break a valid code than
to fix one.

**Double-scanning is safe.** If two lanes scan the same ticket at the same
instant, exactly one gets `SUCCESS` and the other gets `ALREADY_CHECKED_IN`.
This is enforced in a single atomic database operation, so you don't need to
coordinate between your lanes.

**Retry a network failure.** A timed-out request may or may not have been
processed. Retrying is safe — the worst case is `ALREADY_CHECKED_IN`, which
tells you the first attempt actually got through.

**Rate limits.** Scanning (`/checkin`, `/checkin/manual`, `/lookup`): 1500 per
5 minutes per key — far above a real door's pace, and there only to stop a
runaway loop. The roster (`/registrations`) has its own, much smaller budget:
120 per 5 minutes. It is meant to be fetched a handful of times, not polled —
pull it once at the start of the day, and again when you reconcile.

**No internet, no check-in.** This design has one hard requirement: the door
needs a working connection. If the venue's network is unreliable, say so before
the event — JPSME can also export a roster file as an offline fallback, but
that's a different (and less safe) arrangement that has to be set up
deliberately.

## If something goes wrong on the day

- **Every call returns 401** — the key was revoked, or it's been copied
  incorrectly. Check for a trailing space or a line break in your config.
- **Everything returns `INVALID_QR`** — you're likely sending a modified
  string. Log the exact bytes you received from the scanner and compare with
  the `PSME-EVENT:` + 64-hex shape.
- **Everything returns `WRONG_EVENT`** — your key is for a different event.
  Call `/whoami` to see which.

JPSME admins can revoke a key instantly from **Admin → Check-in → Check-in
staff**, and can see when each key was last used. If a key is compromised, say
so immediately — revoking and reissuing takes seconds.

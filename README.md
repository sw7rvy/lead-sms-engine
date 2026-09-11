# Lead SMS Booking Engine

An n8n workflow that captures inbound leads from four channels, qualifies them
over multi-turn SMS with GPT-4o-mini, books into Cal.com, logs to Google Sheets,
and chases leads that go quiet.

Multi-tenant: one workflow instance serves many client businesses, each with its
own Twilio number, Cal.com account, qualification rules, business hours and
Google Sheet, all held in Supabase.

43 functional nodes. Verified against n8n **2.38.5**.

---

## Flow

```
Typeform ──────────────► Extract profile ──► UPSERT client_configs ──► 200 OK

Missed call ──┐
IMAP lead ────┤
Web form ─────┼──► Normalize ──► Resolve tenant ──► Verify signature ──► Authorised?
Inbound SMS ──┘                        │                                      │
                                       └─ no match ──┐         unauthorised ──┤
                                                     ▼                        ▼
                                                 error_log              Send budget?
                                                     ▲                        │
                                          capped ────┘                    within
                                                                              │
                                              Load history ──► Build prompt ──┘
                                                                    │
                    ┌──── booking_ready ────┐                  GPT-4o-mini
                    │                       │                       │
              Cal.com booking          (skip)                  Parse + clamp
                    │                       │                       │
                    └───────► Sheets ◄──────┘               Twilio send SMS
                                 │                                  │
                          lead_threads                     Persist both turns
                                 │
                                 └──► (30 min sweep) ──► re-engagement nudge
```

Every external call has `onError: continueErrorOutput` with 3 retries; the red
branches funnel into one handler that writes `error_log`. An `Error Trigger`
catches anything that escapes node-level handling.

## Channels

| Entry | Trigger | Tenant resolved by |
|---|---|---|
| Missed call | `POST /webhook/twilio-voice-status` | `To` number |
| Inbound SMS | `POST /webhook/twilio-inbound-sms` | `To` number |
| Web form | `POST /webhook/web-lead` | `client_id` or `client_phone` |
| Email | IMAP trigger, subject-filtered | recipient address |
| Onboarding | `POST /webhook/client-onboarding` | n/a |

Missed calls fire on `no-answer`, `busy`, `failed`, `canceled`, or `completed`
with 0s duration. All channels converge on one normalizer producing
`{ lead_phone, client_phone, lead_name, channel_source, raw_message, client_id_or_number }`.

## Booking gate

The model proposing a time is not enough. `booking_ready` requires **both** a
confirmed start time and a collected email, because Cal.com rejects bookings
without one. A confirmed intent missing either is downgraded to `proposed` and
the bot keeps asking. A failed booking still logs to Sheets as `Booking Failed`
and the thread stays in `nurturing` rather than going silent.

## Follow-up ladder

A sweep runs every 30 minutes, takes up to 10 due leads, and nudges them.

| Event | status | count | next nudge |
|---|---|---|---|
| Lead replies | `nurturing` | reset to 0 | +2h |
| Nudge 1 | `nurturing` | 1 | +24h |
| Nudge 2 | `nurturing` | 2 | +72h |
| Nudge 3 | `dead` | 3 | none |
| Booking created | `booked` | — | none |

A reply at any point resets the ladder, so a slow responder gets the full
sequence again rather than falling off.

Guards: quiet hours enforced in the **tenant's** timezone (default 08:00–21:00,
TCPA), optional weekend skip, per-client enable flag, and a hard cap per sweep.
A nudge can never confirm a booking — the lead hasn't answered.

**The sweep loop uses batch size 1 and that is load-bearing.** The shared
conversation chain uses `$('Node').first()` throughout, which is only correct
with one lead in flight per pass. `IF Followup Sweep Run` keeps webhook traffic
out of the loop.

## Security

Three layers. The first two decide whether a request is genuine; the third bounds
what happens if one gets through anyway.

**Intake is authenticated.** `/webhook/web-lead` is public and the tenant is named in
the request body, so without a gate any caller could pick both the tenant and the
destination number and have SMS sent from that tenant's Twilio number. Web-form leads
must present a secret matching `client_configs.webhook_secret`; a tenant with a NULL
secret cannot receive web-form leads at all.

**Twilio webhooks are signature-checked.** The voice and SMS endpoints otherwise accept
a forged `From`/`To`. `Verify Twilio Signature` recomputes `X-Twilio-Signature` — the
called URL, then every POST parameter as `key+value` in ascending key order, HMAC-SHA1
with the tenant's auth token — and compares in constant time.

The node prefers `node:crypto` and falls back to an in-node HMAC-SHA1, because the Code
sandbox blocks `require` unless `NODE_FUNCTION_ALLOW_BUILTIN=crypto` is set on the host.
Setting it upgrades you to OpenSSL with no workflow change. The fallback is verified
against RFC 2202 vectors and `node:crypto`, not trusted.

**Outbound sends are capped.** 60/hour and 500/day per tenant; **4/hour and 10/day to any
single lead**. The per-lead cap is the one that matters — it bounds how hard one person
can be messaged regardless of what upstream believes. Checked before the OpenAI call, so
a capped request costs nothing.

Both intake gates **fail closed**. The send budget deliberately does not: a failed budget
read allows the send, because these caps bound abuse rather than metering, and blocking
every send during a Supabase outage is a worse failure than the one being prevented.

Rejections are written to `error_log` — 401 for unauthorised intake, 429 for a breached
cap — rather than dropped, because repeated hits on one tenant are someone probing.

## Compliance

`STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `QUIT`, `END`, `REVOKE`, `OPTOUT` set
the thread to `opted_out` and stop all nudges. `START` / `UNSTOP` restore it and reset the
ladder. Matching is scoped to the lead **and** the tenant number, so opting out
of one client never silences another. `yes` is deliberately not filtered — it is
the most common booking confirmation.

---

## Setup

**1. Database**

```bash
psql "$SUPABASE_URL" -f supabase-schema.sql
```

Creates `client_configs`, `conversation_history`, `lead_threads`, `error_log`,
the `check_send_budget` function, and RLS enabled with no policies. n8n connects with the **service_role** key,
which bypasses RLS; the anon key is denied on every table. This matters —
`client_configs` stores per-tenant Cal.com API keys in plaintext.

**2. Google Sheet**

```bash
# paste create-leads-sheet.gs into script.google.com and run it
```

Creates the sheet, names the tab `Leads`, writes the seven headers, and prints
the spreadsheet ID. The tab name and headers must match exactly — the Sheets
node appends by header name, so a typo writes blank columns without erroring.

**3. Import the workflow**

```bash
n8n import:workflow --input=multi-channel-lead-sms-booking-engine.json
```

Then attach five credentials in the n8n UI (the JSON carries placeholder IDs):
Supabase (service_role), OpenAI, Twilio, IMAP, Google Sheets.

**4. Point Twilio at it**

- *A message comes in* → `POST https://<host>/webhook/twilio-inbound-sms`
- *Call status changes* → `POST https://<host>/webhook/twilio-voice-status`

Both reply with an empty 200 rather than TwiML, so Twilio sends nothing itself —
the reply comes from the Twilio node at the end of the conversation chain, which
is what lets the model control it.

**5. Add a tenant** via the Typeform webhook, or insert a `client_configs` row
directly. Two columns gate traffic and both fail closed:

| Column | Without it |
|---|---|
| `twilio_auth_token` | **every inbound call and SMS is rejected** |
| `webhook_secret` | web-form leads are rejected |

Get the auth token from the Twilio console under Account Info. Any live web form
must send the tenant's `webhook_secret` in its POST body as `secret` or `token`.

Set `twilio_verify_signatures = false` to bypass signature checking for local
testing. Never in production — it is the only thing standing between a forged
`From` and an SMS sent from the client's number.

---

## Working on it

The workflow JSON is **generated**. `tools/build.js` is the source of truth —
edit the generator, not the artifact.

```bash
node tools/verify-all.js          # rebuild, then run every check
node tools/verify-all.js --check  # check the current JSON without rebuilding
```

See [tools/README.md](tools/README.md) for what each script covers and the one
known false positive.

### Config knobs

| Setting | Where |
|---|---|
| Sweep interval | `minutesInterval` on `Cold Lead Sweep Schedule` |
| Leads per sweep | `MAX_PER_SWEEP` in `CODE_COLD_GATE` |
| Supabase project | `SUPA` constant in `build.js` |
| Cadence, quiet hours, weekend skip | per-tenant columns on `client_configs` |

Cadence lives in **two** places: the DB column default and a JS fallback. The DB
value wins at run time; the fallback only applies when the column is null.
Change both.

---

## Status

Verified end to end with stubbed third-party APIs — a lead was walked through
the real node code, hitting Supabase for every DB step, and the resulting rows
were inspected.

Not yet exercised against live APIs: OpenAI JSON-mode output on the real prompt,
Twilio send, Cal.com booking. Everything upstream of those three calls is tested.

Six defects were caught by executing the code rather than reading it, all fixed:

- `$json` referenced in three `runOnceForAllItems` Code nodes. n8n only defines
  it in `runOnceForEachItem`, so each would throw on every run. `Handle API
  Error` was one of them — failures would have vanished instead of reaching
  `error_log`.
- Sticky notes stored literal `\n` instead of newlines.
- Missing top-level workflow `id`, which `n8n import:workflow` requires.
- Cal.com rejects an empty `responses.notes` with a 400, and the parser emitted
  exactly that whenever the model returned no summary — so bookings would have
  failed only on terse replies, which looks intermittent.
- `/webhook/web-lead` accepted an attacker-chosen tenant and target number.
- The Twilio webhooks accepted a forged `From`/`To`.

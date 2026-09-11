# tools

The workflow JSON is **generated**, not hand-written. `build.js` is the source of
truth. Editing `multi-channel-lead-sms-booking-engine.json` directly works, but the
next `build.js` run overwrites it — change the generator instead.

## Everyday use

```bash
node tools/verify-all.js          # rebuild the workflow, then run every check
node tools/verify-all.js --check  # run checks against the current JSON, no rebuild
```

Exit code 0 means everything passed.

## What each script does

| Script | Purpose |
|---|---|
| `build.js <out.json>` | Generates the workflow. All node definitions, Code-node bodies and connections live here. |
| `validate.js <wf>` | JSON parses, Code bodies compile, expressions balanced, nodes reachable, error branches wired. |
| `audit-json.js <wf>` | Catches `$json` used in `runOnceForAllItems` Code nodes — n8n only defines it in `runOnceForEachItem`, so this throws at run time. Found 3 real bugs. |
| `check-notes.js <wf>` | Sticky notes contain real newlines, not literal `\n`. |
| `test-normalize.js <wf>` | Runs `Normalize Lead Payload` against all channel payloads (SMS, media SMS, missed call, 0s call, web form, IMAP). |
| `test-filter.js <wf>` | Opt-out keyword filter — STOP/CANCEL blocked, `yes` allowed through. |
| `test-followup.js <wf>` | Cold-lead gate, quiet hours, cadence ladder, STOP/START, persist expression. |
| `verify-import.js <src> <exported>` | Diffs a round-trip through a real n8n instance. See below. |
| `dryrun.js <wf> <cfg.json> [out.json]` | Walks a lead through the real node code end to end, stubbing OpenAI/Twilio/Cal.com and emitting the exact Supabase calls n8n would make. The route is derived from `wf.connections`, so it cannot drift from the workflow. Omit `twilio_auth_token` from the config to watch the signature gate reject the lead. |

## Known false positive

`validate.js` always prints:

```
UNEXPECTED SECOND OUTPUT: Loop Over Cold Leads
```

`splitInBatches` legitimately has two outputs (done / loop) and the checker does
not model that node type. `verify-all.js` tolerates it. Everything else it prints
is real.

## Round-trip check against a live n8n

Confirms n8n did not silently drop or downgrade anything on import:

```bash
n8n import:workflow --input=multi-channel-lead-sms-booking-engine.json
n8n export:workflow --id=LeadSMSBooking01 --output=/tmp/roundtrip.json
node tools/verify-import.js multi-channel-lead-sms-booking-engine.json /tmp/roundtrip.json
```

Compares node count, names, types + typeVersions, connections, Code bodies
byte-for-byte, and expression count. The typeVersion check is the important one:
an unresolved node type imports without error and then fails at run time.

The workflow needs a top-level `id` for `n8n import:workflow` — the UI importer
generates one, the CLI does not. `build.js` sets `id: 'LeadSMSBooking01'`.

## Changing common settings

All in `build.js`:

- **Sweep interval** — `minutesInterval` on `Cold Lead Sweep Schedule`
- **Leads per sweep** — `MAX_PER_SWEEP` at the top of `CODE_COLD_GATE`
- **Supabase project** — the `SUPA` constant
- **Follow-up cadence** — the `[2, 24, 72]` fallbacks *and* the DB column default
  in `supabase-schema.sql`. The DB value wins at run time; the JS values only
  apply when the column is null. Change both.

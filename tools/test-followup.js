const fs = require('fs');
const wf = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const code = (n) => wf.nodes.find((x) => x.name === n).parameters.jsCode;
let fail = 0;

/* ---------- 1. cold gate ---------- */
const gate = (rows) => new Function('$input', 'console', code('Gate Quiet Hours & Cadence'))(
  { all: () => rows.map((j) => ({ json: j })) }, { log: () => {} });

const cfg = (o) => Object.assign({
  client_id: 'c1', status: 'active', followup_enabled: true, timezone: 'America/New_York',
  followup_cadence_hours: [2, 24, 72], quiet_hours_start: 8, quiet_hours_end: 21,
  twilio_phone_number: '+15559998888',
}, o || {});

const thread = (o) => Object.assign({
  client_id: 'c1', lead_phone: '+15551234567', client_phone: '+15559998888',
  status: 'nurturing', followup_count: 0,
  last_outbound_at: new Date(Date.now() - 3 * 3600000).toISOString(),
  next_followup_at: new Date(Date.now() - 600000).toISOString(),
  lead_name: 'Dana', client_configs: cfg(),
}, o || {});

const nyHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date()));
const awake = nyHour >= 8 && nyHour < 21;
console.log('--- cold gate (NY local hour ' + nyHour + ', inside 08-21 window: ' + awake + ') ---');

const T = [
  ['due lead', thread(), awake ? 1 : 0],
  ['ladder exhausted', thread({ followup_count: 3 }), 0],
  ['thread booked', thread({ status: 'booked' }), 0],
  ['thread opted_out', thread({ status: 'opted_out' }), 0],
  ['client paused', thread({ client_configs: cfg({ followup_enabled: false }) }), 0],
  ['client inactive', thread({ client_configs: cfg({ status: 'paused' }) }), 0],
  // Time-independent windows: start===end is always closed, 0-24 is always open.
  ['window closed', thread({ client_configs: cfg({ quiet_hours_start: nyHour, quiet_hours_end: nyHour }) }), 0],
  ['window open 24h', thread({ client_configs: cfg({ quiet_hours_start: 0, quiet_hours_end: 24 }) }), 1],
  ['weekend skip on', thread({ client_configs: cfg({ quiet_hours_start: 0, quiet_hours_end: 24, followup_skip_weekends: true }) }),
    ['sat', 'sun'].includes(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date()).toLowerCase()) ? 0 : 1],
  ['embedded as array', thread({ client_configs: [cfg()] }), awake ? 1 : 0],
  ['no config', thread({ client_configs: null }), 0],
];
for (const [name, row, want] of T) {
  const got = gate([row]).length;
  if (got !== want) { fail++; console.log('  FAIL ' + name + ' want=' + want + ' got=' + got); }
  else console.log('  ok   ' + name.padEnd(20) + '-> ' + got);
}

// Force the window open so the cap is testable at any wall-clock time.
const open = cfg({ quiet_hours_start: 0, quiet_hours_end: 24 });
const many = Array.from({ length: 40 }, (_, i) => thread({
  lead_phone: '+1555000' + String(1000 + i),
  client_configs: open,
  next_followup_at: new Date(Date.now() - (40 - i) * 60000).toISOString(),
}));
const batch = gate(many);
const capOk = batch.length === 10;
if (!capOk) fail++;
console.log('  ' + (capOk ? 'ok  ' : 'FAIL') + ' batch cap 10 of 40 -> ' + batch.length);
// Oldest-due must be served first.
const orderOk = batch[0].json.phone === '+15550001000';
if (!orderOk) fail++;
console.log('  ' + (orderOk ? 'ok  ' : 'FAIL') + ' oldest-due served first -> ' + batch[0].json.phone);

/* ---------- 2. gate payload survives the normalizer ---------- */
console.log('--- gate payload -> Normalize Lead Payload ---');
const norm = (j) => new Function('$input', '$execution', code('Normalize Lead Payload'))(
  { all: () => [{ json: j }] }, { id: 'e1' })[0].json;
const gp = batch.length ? batch[0].json : {
  source: 'followup', client_id: 'c1', client_phone: '+15559998888', phone: '+15551234567',
  name: 'Dana', followup_step: 1, message: 'RE-ENGAGEMENT TRIGGER: attempt 2 of 3.',
};
const n = norm(gp);
const nOk = n.channel_source === 'followup' && n.followup_step === gp.followup_step && n.client_id_or_number === 'c1';
if (!nOk) fail++;
console.log('  ' + (nOk ? 'ok  ' : 'FAIL') + ' channel=' + n.channel_source + ' step=' + n.followup_step + ' tenant=' + n.client_id_or_number + ' phone=' + n.lead_phone);

/* ---------- 3. ladder state in Build Sheet Row ---------- */
console.log('--- follow-up ladder / thread state ---');
const sheet = (ai, booking) => new Function('$', code('Build Sheet Row'))((name) => ({
  first: () => {
    if (name === 'Parse AI Response') return { json: ai };
    if (name === 'Cal.com Create Booking') {
      if (!booking) throw new Error('node did not execute');
      return { json: booking };
    }
    throw new Error('no such node');
  },
}))[0].json;

const baseAi = {
  client_id: 'c1', lead_phone: '+15551234567', client_phone: '+15559998888', lead_name: 'Dana',
  lead_email: 'd@x.com', google_sheet_id: 'sheet1', channel_source: 'sms',
  followup_cadence_hours: [2, 24, 72], followup_step: 0, turn: 2,
  booking_intent: 'none', qualified: true, notes: 'wants a quote', inbound_message: 'hi',
};
const L = [
  ['lead replied', Object.assign({}, baseAi), null, 'nurturing', 0],
  ['nudge 1 sent', Object.assign({}, baseAi, { channel_source: 'followup', followup_step: 0 }), null, 'nurturing', 1],
  ['nudge 2 sent', Object.assign({}, baseAi, { channel_source: 'followup', followup_step: 1 }), null, 'nurturing', 2],
  ['nudge 3 final', Object.assign({}, baseAi, { channel_source: 'followup', followup_step: 2 }), null, 'dead', 3],
  ['reply after 2', Object.assign({}, baseAi, { channel_source: 'sms', followup_step: 0 }), null, 'nurturing', 0],
  ['booked', Object.assign({}, baseAi, { booking_intent: 'confirmed' }), { uid: 'bk_1', startTime: '2026-09-12T14:00:00Z' }, 'booked', 0],
];
for (const [name, ai, bk, wantStatus, wantCount] of L) {
  const r = sheet(ai, bk);
  const t = r._thread;
  const ok = t.status === wantStatus && t.followup_count === wantCount;
  if (!ok) fail++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + name.padEnd(14) +
    'status=' + t.status.padEnd(10) + 'count=' + t.followup_count +
    ' next=' + (t.next_followup_at ? t.next_followup_at.slice(5, 16) : 'none').padEnd(12) +
    ' last_inbound=' + (('last_inbound_at' in t) ? 'written' : 'preserved').padEnd(9) +
    ' sheet="' + r.Status + '"');
}

/* ---------- 4. opt-out / opt-in ---------- */
console.log('--- STOP / START handling ---');
// The handler now reads the normalizer's classification rather than the raw
// webhook, because the branch moved behind signature verification. Drive it
// through the real normalizer so the coupling is exercised, not mocked.
const normalizeSms = (body) => new Function('$input', '$execution', code('Normalize Lead Payload'))(
  { all: () => [{ json: { body: { MessageSid: 'SM1', From: '+15551234567', To: '+15559998888', Body: body, NumMedia: '0' } } }] },
  { id: 'e1' })[0].json;
const oo = (body) => new Function('$', code('Handle Non-Actionable SMS'))(
  () => ({ first: () => ({ json: normalizeSms(body) }) }));
for (const [b, want] of [['STOP', 'opted_out'], ['cancel.', 'opted_out'], ['Unsubscribe!', 'opted_out'],
  ['START', 'nurturing'], ['unstop', 'nurturing'], ['HELP', null], ['', null], ['yes', null]]) {
  const r = oo(b);
  const got = r.length ? r[0].json.new_status : null;
  const ok = got === want;
  if (!ok) fail++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + JSON.stringify(b).padEnd(14) + '-> ' + (got || 'no-op'));
}

/* ---------- 5. persist jsonBody expression ---------- */
console.log('--- Persist Conversation Turn expression ---');
const jb = wf.nodes.find((x) => x.name === 'Persist Conversation Turn').parameters.jsonBody;
const inner = jb.replace(/^=\{\{/, '').replace(/\}\}$/, '');
for (const [label, ch, want] of [['inbound reply', 'sms', 'user,assistant'], ['followup nudge', 'followup', 'assistant']]) {
  const ai = Object.assign({}, baseAi, { channel_source: ch, reply: 'hi there', turn: 3, followup_step: 1 });
  const rows = JSON.parse(new Function('$', '$json', '$execution', 'return (' + inner + ')')(
    () => ({ first: () => ({ json: ai }) }), { sid: 'SM9' }, { id: 'e1' }));
  const roles = rows.map((r) => r.role).join(',');
  const ok = roles === want;
  if (!ok) fail++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label.padEnd(15) + 'rows=[' + roles + '] is_followup=' + rows[rows.length - 1].is_followup);
}

console.log(fail === 0 ? '\nALL FOLLOW-UP TESTS PASS' : '\n' + fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);

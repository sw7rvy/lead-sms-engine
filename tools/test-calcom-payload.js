/**
 * Contract test for the outbound API payloads.
 *
 * These three calls have never run against a live API. This asserts the request
 * shapes against the documented contracts so a malformed body is caught here
 * rather than at the first real booking.
 *
 * Cal.com v1 POST /bookings requires eventTypeId, start and an attendee email,
 * and rejects an empty string for responses.notes with a 400.
 */
const fs = require('fs');
const wf = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const node = (n) => wf.nodes.find((x) => x.name === n);
let fail = 0;
const check = (label, cond, detail) => {
  if (!cond) fail++;
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + ' ' + label + (detail && !cond ? '  -> ' + detail : ''));
};

/* ---- run Parse AI Response with a model reply that omits notes ---- */
const code = node('Parse AI Response').parameters.jsCode;
const cfg = {
  client_id: 'c1', business_name: 'Test Co', twilio_phone_number: '+15005550006',
  calcom_api_key: 'k', event_type_id: 42, google_sheet_id: 's', timezone: 'America/New_York',
  followup_cadence_hours: [2, 24, 72],
};
const lead = {
  lead_phone: '+15558675309', lead_name: 'Dana', lead_email: 'd@x.com',
  channel_source: 'sms', raw_message: 'hi', followup_step: 0,
};
const runParse = (aiObj) => new Function('$input', '$', code)(
  { first: () => ({ json: { choices: [{ message: { content: JSON.stringify(aiObj) } }], usage: {} } }) },
  (n) => ({ first: () => ({ json: n === 'Fetch Client Config' ? cfg : n === 'Normalize Lead Payload' ? lead : { _meta: { turn: 1 } } }) })
)[0].json;

const confirmed = {
  reply: 'See you then.', qualified: true, booking_intent: 'confirmed',
  booking_start: new Date(Date.now() + 86400000).toISOString(),
  lead_email: 'd@x.com', lead_name: 'Dana',
};

console.log('--- responses.notes is never empty (Cal.com 400 otherwise) ---');
for (const [label, ai] of [
  ['model omits notes', Object.assign({}, confirmed)],
  ['model sends ""', Object.assign({}, confirmed, { notes: '' })],
  ['model sends whitespace', Object.assign({}, confirmed, { notes: '   ' })],
  ['model sends real notes', Object.assign({}, confirmed, { notes: 'Leaking sink, Marietta' })],
]) {
  const out = runParse(ai);
  check(label + ' -> notes="' + out.notes.slice(0, 40) + '"', out.notes.trim().length > 0);
}

/* ---- evaluate the Cal.com jsonBody with a real Parse output ---- */
console.log('--- Cal.com v1 POST /bookings body ---');
const ai = runParse(Object.assign({}, confirmed, { notes: '' }));
const expr = node('Cal.com Create Booking').parameters.jsonBody
  .replace(/^=\{\{/, '').replace(/\}\}$/, '');
const body = JSON.parse(new Function('$', '$execution', 'return (' + expr + ')')(
  () => ({ first: () => ({ json: ai }) }), { id: 'e1' }
));

check('eventTypeId is a number', typeof body.eventTypeId === 'number' && !Number.isNaN(body.eventTypeId), String(body.eventTypeId));
check('start is ISO-8601', !Number.isNaN(Date.parse(body.start)), String(body.start));
check('start is in the future', Date.parse(body.start) > Date.now());
check('responses.email present', !!body.responses && !!body.responses.email);
check('responses.name present', !!body.responses && !!body.responses.name);
check('responses.notes non-empty', !!body.responses && String(body.responses.notes || '').trim().length > 0, JSON.stringify(body.responses && body.responses.notes));
check('description non-empty', String(body.description || '').trim().length > 0);
check('timeZone present', !!body.timeZone);
check('smsReminderNumber is E.164', /^\+[1-9]\d{7,14}$/.test(body.responses.smsReminderNumber || ''), body.responses.smsReminderNumber);

/* ---- Twilio send params ---- */
console.log('--- Twilio SMS params ---');
const tw = node('Twilio Send SMS').parameters;
const ev = (e) => e.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
const val = (e) => new Function('$json', 'return (' + ev(e) + ')')(ai);
const from = val(tw.from), to = val(tw.to), msg = val(tw.message);
check('from is E.164', /^\+[1-9]\d{7,14}$/.test(from), from);
check('to is E.164', /^\+[1-9]\d{7,14}$/.test(to), to);
check('message non-empty', String(msg).length > 0);
check('message <= 1600 chars (Twilio hard limit)', String(msg).length <= 1600, String(msg).length + ' chars');

/* ---- OpenAI request body ---- */
console.log('--- OpenAI chat/completions body ---');
const oa = node('OpenAI GPT-4o-mini').parameters.jsonBody.replace(/^=\{\{/, '').replace(/\}\}$/, '');
const msgs = {
  model: 'gpt-4o-mini', temperature: 0.4, max_tokens: 400,
  response_format: { type: 'json_object' },
  messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }],
};
const oaBody = JSON.parse(new Function('$json', 'return (' + oa + ')')(msgs));
check('model set', oaBody.model === 'gpt-4o-mini', oaBody.model);
check('response_format is json_object', oaBody.response_format && oaBody.response_format.type === 'json_object');
check('messages is a non-empty array', Array.isArray(oaBody.messages) && oaBody.messages.length > 0);
check('every message has role+content', oaBody.messages.every((m) => m.role && typeof m.content === 'string'));
check('temperature within 0..2', oaBody.temperature >= 0 && oaBody.temperature <= 2);

console.log(fail === 0 ? '\nAPI CONTRACT TESTS PASS' : '\n' + fail + ' CONTRACT FAILURES');
process.exit(fail === 0 ? 0 : 1);

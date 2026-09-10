/**
 * Offline dry run of the workflow.
 *
 * Executes each Code node's real jsCode and evaluates each HTTP node's real
 * n8n expressions, so what you see is what n8n would actually send.
 * The three external APIs (OpenAI, Twilio, Cal.com) are stubbed; every
 * Supabase call is emitted as JSON for the caller to apply for real.
 */
const fs = require('fs');
const wf = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const node = (n) => {
  const f = wf.nodes.find((x) => x.name === n);
  if (!f) throw new Error('no node named ' + n);
  return f;
};
const EXEC = { id: 'dryrun_' + Date.now() };
const WORKFLOW = { id: 'wf_test', name: wf.name };

// --- node output registry, so $('Name').first() resolves like n8n ---
const out = {};
const $ = (name) => {
  if (!(name in out)) throw new Error('node "' + name + '" has not executed');
  return { first: () => ({ json: out[name][0] }), all: () => out[name].map((j) => ({ json: j })) };
};

function runCode(name, items) {
  const n = node(name);
  const fn = new Function('$input', '$', '$execution', '$workflow', 'console', n.parameters.jsCode);
  const wrapped = items.map((j) => ({ json: j }));
  const res = fn(
    // Mirror n8n's $input surface: all(), first(), last(), itemMatching absent.
    { all: () => wrapped, first: () => wrapped[0], last: () => wrapped[wrapped.length - 1] },
    $, EXEC, WORKFLOW,
    { log: (m) => console.log('      [node log] ' + m) }
  );
  out[name] = (res || []).map((r) => r.json);
  return out[name];
}

function evalExpr(expr, $json) {
  if (typeof expr !== 'string' || expr[0] !== '=') return expr;
  return expr.slice(1).replace(/\{\{([\s\S]*?)\}\}/g, (_, code) => {
    const fn = new Function('$json', '$', '$execution', '$workflow', 'return (' + code + ')');
    return String(fn($json, $, EXEC, WORKFLOW));
  });
}

function evalIf(name, $json) {
  const conds = node(name).parameters.conditions.conditions;
  return conds.every((c) => {
    const v = evalExpr(c.leftValue, $json);
    return v === 'true' || v === true;
  });
}

const emitted = [];
function http(name, $json) {
  const p = node(name).parameters;
  const rec = {
    node: name,
    method: p.method,
    url: evalExpr(p.url, $json),
    body: p.jsonBody ? evalExpr(p.jsonBody, $json) : undefined,
  };
  emitted.push(rec);
  console.log('   -> ' + (p.method || 'GET') + ' ' + rec.url.replace(/^https:\/\/[a-z]+\.supabase\.co/, '{supabase}'));
  if (rec.body) console.log('      body: ' + rec.body.replace(/\s+/g, ' ').slice(0, 300));
  return rec;
}

const step = (n, s) => console.log('\n[' + n + '] ' + s);

/* ================= INBOUND SMS FROM A NEW LEAD ================= */
const INBOUND = {
  body: {
    MessageSid: 'SM' + 'test'.padEnd(30, '0'),
    From: '+15558675309',
    To: '+15005550006',          // matches test_client_001
    Body: 'Hi - kitchen sink is leaking under the cabinet, water everywhere. Can someone come out today?',
    NumMedia: '0',
  },
};

console.log('='.repeat(70));
console.log('DRY RUN :: inbound SMS from a brand-new lead');
console.log('='.repeat(70));
console.log('inbound: "' + INBOUND.body.Body + '"');
console.log('from ' + INBOUND.body.From + ' to ' + INBOUND.body.To);

step(1, 'IF Actionable Inbound SMS');
const actionable = evalIf('IF Actionable Inbound SMS', INBOUND);
console.log('   actionable = ' + actionable);
if (!actionable) { console.log('DROPPED'); process.exit(0); }

step(2, 'Normalize Lead Payload');
const norm = runCode('Normalize Lead Payload', [INBOUND])[0];
console.log('   channel=' + norm.channel_source + '  lead=' + norm.lead_phone + '  tenant=' + norm.client_id_or_number);

step(3, 'Fetch Client Config  [REAL - caller executes]');
http('Fetch Client Config', norm);
// Row as it exists in the live DB (seeded earlier).
out['Fetch Client Config'] = [JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))];
const cfg = out['Fetch Client Config'][0];
console.log('   resolved: ' + cfg.business_name + '  cadence=' + JSON.stringify(cfg.followup_cadence_hours));

step(4, 'IF Client Config Found');
console.log('   found = ' + evalIf('IF Client Config Found', cfg));

step(5, 'Fetch Conversation History  [REAL - caller executes]');
http('Fetch Conversation History', cfg);
out['Fetch Conversation History'] = [];   // new lead, no prior turns
console.log('   history rows = 0 (new lead)');

step(6, 'Build OpenAI Messages');
const msgs = runCode('Build OpenAI Messages', out['Fetch Conversation History'])[0];
console.log('   model=' + msgs.model + '  messages=' + msgs.messages.length + '  turn=' + msgs._meta.turn);
console.log('   --- system prompt sent to the model ---');
console.log(msgs.messages[0].content.split('\n').map((l) => '   | ' + l).join('\n'));
console.log('   --- user turn ---');
console.log('   | ' + msgs.messages[1].content);

step(7, 'OpenAI GPT-4o-mini  [STUBBED]');
http('OpenAI GPT-4o-mini', msgs);
const STUB = {
  reply: 'Sorry about the leak! Shut the valve under the sink if you can. We can be there today 2-4pm - want me to lock that in? What suburb are you in?',
  qualified: true,
  booking_intent: 'proposed',
  booking_start: null,
  duration_minutes: 60,
  lead_name: null,
  lead_email: null,
  notes: 'Active leak under kitchen sink, wants same-day. Suburb not yet confirmed.',
};
out['OpenAI GPT-4o-mini'] = [{
  choices: [{ message: { content: JSON.stringify(STUB) } }],
  usage: { total_tokens: 512 },
}];
console.log('   stubbed reply: "' + STUB.reply + '" (' + STUB.reply.length + ' chars)');

step(8, 'Parse AI Response');
const ai = runCode('Parse AI Response', out['OpenAI GPT-4o-mini'])[0];
console.log('   qualified=' + ai.qualified + '  intent=' + ai.booking_intent +
  '  booking_ready=' + ai.booking_ready + '  reply_len=' + ai.reply.length);

step(9, 'Twilio Send SMS  [STUBBED]');
const tw = node('Twilio Send SMS').parameters;
console.log('   from: ' + evalExpr(tw.from, ai));
console.log('   to:   ' + evalExpr(tw.to, ai));
console.log('   msg:  ' + evalExpr(tw.message, ai));
out['Twilio Send SMS'] = [{ sid: 'SM_stub_outbound_0001' }];

step(10, 'Persist Conversation Turn  [REAL - caller executes]');
http('Persist Conversation Turn', out['Twilio Send SMS'][0]);
out['Persist Conversation Turn'] = [{}];

step(11, 'IF Booking Confirmed');
const booked = evalIf('IF Booking Confirmed', {});
console.log('   booking_ready = ' + booked + '  -> ' + (booked ? 'Cal.com' : 'skip to logging'));

step(12, 'Build Sheet Row');
const row = runCode('Build Sheet Row', [{}])[0];
console.log('   Status="' + row.Status + '"  next_nudge=' + row._thread.next_followup_at);

step(13, 'Append Lead To Google Sheet  [STUBBED]');
const cols = node('Append Lead To Google Sheet').parameters.columns.value;
for (const k of Object.keys(cols)) {
  console.log('   ' + k.padEnd(15) + ' = ' + String(evalExpr(cols[k], row)).slice(0, 90));
}

step(14, 'Upsert Lead Thread State  [REAL - caller executes]');
http('Upsert Lead Thread State', row);

step(15, 'IF Followup Sweep Run');
console.log('   from sweep = ' + evalIf('IF Followup Sweep Run', {}) + ' (webhook run -> ends here)');

console.log('\n' + '='.repeat(70));
console.log('Supabase calls to apply for real:');
for (const e of emitted.filter((x) => x.url.includes('supabase'))) {
  console.log('  ' + e.method + ' ' + e.url.split('/rest/v1/')[1].split('?')[0]);
}
fs.writeFileSync(process.argv[4], JSON.stringify(emitted, null, 2));
console.log('written to ' + process.argv[4]);

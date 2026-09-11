/**
 * Walks a lead through the real node code end to end.
 *
 * The path is derived from wf.connections, not hardcoded. An earlier version
 * listed the steps by hand, and after the security nodes were added it kept
 * running happily while silently walking a chain that no longer existed --
 * reporting a confident picture of the wrong workflow. Deriving the route means
 * the trace is wrong only if the workflow is.
 *
 *   node tools/dryrun.js <workflow.json> <tenant-config.json> [emitted.json]
 *
 * External APIs are stubbed; every Supabase call is emitted as the exact
 * request n8n would send.
 */
const fs = require('fs');
const crypto = require('crypto');

const wf = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const CFG = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const OUT = process.argv[4] || null;

const node = (n) => {
  const f = wf.nodes.find((x) => x.name === n);
  if (!f) throw new Error('no node named ' + n);
  return f;
};
const EXEC = { id: 'dryrun_' + Date.now() };
const WORKFLOW = { id: 'wf_dryrun', name: wf.name };

const out = {};
const $ = (name) => {
  if (!(name in out)) throw new Error('node "' + name + '" has not executed');
  return {
    first: () => ({ json: out[name][0] }),
    all: () => out[name].map((j) => ({ json: j })),
  };
};

const mkInput = (items) => {
  const wrapped = items.map((j) => ({ json: j }));
  return { all: () => wrapped, first: () => wrapped[0], last: () => wrapped[wrapped.length - 1] };
};

function evalExpr(expr, $json) {
  if (typeof expr !== 'string' || expr[0] !== '=') return expr;
  return expr.slice(1).replace(/\{\{([\s\S]*?)\}\}/g, (_, code) =>
    String(new Function('$json', '$', '$execution', '$workflow', 'return (' + code + ')')(
      $json, $, EXEC, WORKFLOW)));
}

const emitted = [];

/* ---------------- per-type executors ---------------- */

function runCode(name, items) {
  const n = node(name);
  const fn = new Function('$input', '$', '$execution', '$workflow', 'console', n.parameters.jsCode);
  const res = fn(mkInput(items), $, EXEC, WORKFLOW, { log: (m) => trace('      log: ' + m) });
  return (res || []).map((r) => r.json);
}

function runIf(name, items) {
  const conds = node(name).parameters.conditions.conditions;
  const $json = items[0] || {};
  const pass = conds.every((c) => {
    const v = evalExpr(c.leftValue, $json);
    return v === 'true' || v === true;
  });
  return { pass, items };
}

// Stubs for everything that leaves the machine. Supabase calls are recorded
// verbatim; the three third-party APIs return canned, well-formed responses.
function runHttp(name, items) {
  const p = node(name).parameters;
  const $json = items[0] || {};
  const url = evalExpr(p.url, $json);
  const body = p.jsonBody ? evalExpr(p.jsonBody, $json) : undefined;
  emitted.push({ node: name, method: p.method || 'GET', url, body });
  trace('      ' + (p.method || 'GET') + ' ' + url.replace(/^https:\/\/[a-z0-9]+\.supabase\.co/, '{supabase}').slice(0, 110));

  if (name === 'Fetch Client Config') return [CFG];
  if (name === 'Fetch Conversation History') return [];
  if (name === 'Check Send Budget') return [{ tenant_hour: 0, tenant_day: 0, lead_hour: 0, lead_day: 0 }];
  if (name === 'OpenAI GPT-4o-mini') {
    return [{
      choices: [{ message: { content: JSON.stringify({
        reply: 'Sorry about the leak! We can be there today 2-4pm. Want me to lock that in?',
        qualified: true, booking_intent: 'proposed', booking_start: null,
        notes: 'Active leak under kitchen sink, wants same-day.',
      }) } }],
      usage: { total_tokens: 480 },
    }];
  }
  if (name === 'Cal.com Create Booking') return [{ uid: 'bk_stub', startTime: '2026-09-13T18:00:00Z' }];
  return [{}];
}

function runTwilio(name, items) {
  const p = node(name).parameters;
  const $json = items[0] || {};
  trace('      from ' + evalExpr(p.from, $json) + ' -> ' + evalExpr(p.to, $json));
  trace('      "' + evalExpr(p.message, $json) + '"');
  return [{ sid: 'SM_stub_outbound' }];
}

function runSheets(name, items) {
  const cols = node(name).parameters.columns.value;
  const $json = items[0] || {};
  for (const k of Object.keys(cols)) {
    trace('      ' + k.padEnd(15) + '= ' + String(evalExpr(cols[k], $json)).slice(0, 70));
  }
  return items;
}

/* ---------------- the walk ---------------- */

let depth = 0;
const lines = [];
const trace = (s) => { lines.push(s); console.log(s); };

const TERMINAL = new Set(['Log Error To Supabase', 'Respond Onboarding OK', 'Sweep Complete']);

function walk(name, items, step) {
  const n = node(name);
  const kind = n.type.replace('n8n-nodes-base.', '');
  let produced = items;
  let branch = 0;

  switch (kind) {
    case 'code': produced = runCode(name, items); break;
    case 'httpRequest': produced = runHttp(name, items); break;
    case 'twilio': produced = runTwilio(name, items); break;
    case 'googleSheets': produced = runSheets(name, items); break;
    case 'if': {
      const r = runIf(name, items);
      branch = r.pass ? 0 : 1;
      produced = r.items;
      trace('  [' + step + '] ' + name + '  -> ' + (r.pass ? 'true' : 'FALSE'));
      break;
    }
    default: break;
  }
  if (kind !== 'if') trace('  [' + step + '] ' + name + (produced.length !== 1 ? '  (' + produced.length + ' items)' : ''));

  if (TERMINAL.has(name)) { trace('  [end] ' + name); return; }

  const conn = wf.connections[name];
  if (!conn || !conn.main[branch] || conn.main[branch].length === 0) {
    trace('  [end] no outgoing connection from ' + name + ' on output ' + branch);
    return;
  }
  // Follow the first target on the chosen output; error outputs are not walked.
  const next = conn.main[branch][0].node;
  out[name] = produced;
  walk(next, produced, step + 1);
}

/* ---------------- entry ---------------- */

const INBOUND = {
  body: {
    MessageSid: 'SMdryrun0000000000000000000000',
    From: '+15558675309',
    To: CFG.twilio_phone_number,
    Body: 'Kitchen sink is leaking under the cabinet. Can someone come out today?',
    NumMedia: '0',
  },
  headers: { host: 'n8n.example.com', 'x-forwarded-proto': 'https' },
  webhookUrl: 'https://n8n.example.com/webhook/twilio-inbound-sms',
};

// Sign it the way Twilio would, so the signature gate sees a genuine request.
if (CFG.twilio_auth_token) {
  const b = INBOUND.body;
  INBOUND.headers['x-twilio-signature'] = crypto.createHmac('sha1', CFG.twilio_auth_token)
    .update(INBOUND.webhookUrl + Object.keys(b).sort().map((k) => k + b[k]).join(''), 'utf8')
    .digest('base64');
} else {
  console.log('  NOTE: tenant config has no twilio_auth_token, so the signature gate');
  console.log('        will reject this lead. That is the production behaviour.\n');
}

const ENTRY = 'Twilio Inbound SMS Webhook';
out[ENTRY] = [INBOUND];

console.log('='.repeat(70));
console.log('DRY RUN :: inbound SMS, path derived from wf.connections');
console.log('='.repeat(70));
console.log('  "' + INBOUND.body.Body + '"');
console.log('  ' + INBOUND.body.From + ' -> ' + INBOUND.body.To + '\n');

walk(wf.connections[ENTRY].main[0][0].node, [INBOUND], 1);

console.log('\n' + '='.repeat(70));
console.log('Supabase calls this execution would make:');
for (const e of emitted.filter((x) => x.url.includes('supabase'))) {
  console.log('  ' + e.method + ' ' + e.url.split('/rest/v1/')[1].split('?')[0]);
}
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(emitted, null, 2)); console.log('emitted -> ' + OUT); }

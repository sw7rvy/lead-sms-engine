/**
 * Outbound send caps. These bound the blast radius of anything that gets past
 * the intake gates -- a leaked secret or auth token, a runaway sweep, a bug --
 * by capping how much SMS one tenant emits and how hard one lead is hit.
 *
 * The check sits before the OpenAI node, so a capped request costs nothing.
 */
const fs = require('fs');
const wf = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const node = (n) => wf.nodes.find((x) => x.name === n);
let fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label.padEnd(50) + (got ? 'SEND' : 'capped') +
    (ok ? '' : '  (wanted ' + (want ? 'SEND' : 'capped') + ')'));
};

const CAPS = {
  client_id: 'c1',
  max_sms_per_hour: 60, max_sms_per_day: 500,
  max_sms_per_lead_per_hour: 4, max_sms_per_lead_per_day: 10,
};

const gate = node('IF Within Send Budget').parameters.conditions.conditions[0].leftValue
  .replace(/^=\{\{/, '').replace(/\}\}$/, '');
const allowed = (counts) => new Function('$json', '$', 'return (' + gate + ')')(
  counts, () => ({ first: () => ({ json: CAPS }) }));

console.log('--- under every cap ---');
check('nothing sent yet', allowed({ tenant_hour: 0, tenant_day: 0, lead_hour: 0, lead_day: 0 }), true);
check('one below each cap', allowed({ tenant_hour: 59, tenant_day: 499, lead_hour: 3, lead_day: 9 }), true);

console.log('--- each cap blocks on its own ---');
check('tenant hourly cap reached', allowed({ tenant_hour: 60, tenant_day: 0, lead_hour: 0, lead_day: 0 }), false);
check('tenant daily cap reached', allowed({ tenant_hour: 0, tenant_day: 500, lead_hour: 0, lead_day: 0 }), false);
check('per-lead hourly cap reached', allowed({ tenant_hour: 0, tenant_day: 0, lead_hour: 4, lead_day: 0 }), false);
check('per-lead daily cap reached', allowed({ tenant_hour: 0, tenant_day: 0, lead_hour: 0, lead_day: 10 }), false);
check('over a cap, not merely at it', allowed({ tenant_hour: 999, tenant_day: 0, lead_hour: 0, lead_day: 0 }), false);

console.log('--- boundary is strict-less-than (count is what was already sent) ---');
check('lead at 3 of 4 may send the 4th', allowed({ tenant_hour: 0, tenant_day: 0, lead_hour: 3, lead_day: 0 }), true);
check('lead at 4 of 4 may not send a 5th', allowed({ tenant_hour: 0, tenant_day: 0, lead_hour: 4, lead_day: 0 }), false);

console.log('--- degradation: a failed budget read must not take the product down ---');
check('empty response reads as zero', allowed({}), true);
check('null-ish counts read as zero', allowed({ tenant_hour: null, tenant_day: undefined, lead_hour: null, lead_day: null }), true);

console.log('--- the cap check runs before the model call ---');
const conns = wf.connections;
const budgetFeeds = (conns['IF Within Send Budget'].main[0] || []).map((c) => c.node);
const capFeeds = (conns['IF Within Send Budget'].main[1] || []).map((c) => c.node);
const okOrder = budgetFeeds.includes('Fetch Conversation History') && !budgetFeeds.includes('OpenAI GPT-4o-mini');
if (!okOrder) fail++;
console.log('  ' + (okOrder ? 'ok  ' : 'FAIL') + ' allowed path continues to the conversation chain');
const okCapped = capFeeds.includes('Flag Rate Limited');
if (!okCapped) fail++;
console.log('  ' + (okCapped ? 'ok  ' : 'FAIL') + ' capped path goes to Flag Rate Limited, not to OpenAI');

// The budget node must sit upstream of OpenAI, or a capped request still costs money.
const reaches = (from, target, seen = new Set()) => {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const c = conns[from];
  if (!c) return false;
  return c.main.some((out) => (out || []).some((e) => reaches(e.node, target, seen)));
};
const gatesOpenAI = reaches('Check Send Budget', 'OpenAI GPT-4o-mini');
if (!gatesOpenAI) fail++;
console.log('  ' + (gatesOpenAI ? 'ok  ' : 'FAIL') + ' Check Send Budget is upstream of the OpenAI node');

console.log('--- rate-limit event is logged with the breached cap named ---');
const rl = new Function('$input', '$', '$workflow', '$execution', node('Flag Rate Limited').parameters.jsCode)(
  { first: () => ({ json: { tenant_hour: 1, tenant_day: 1, lead_hour: 4, lead_day: 4 } }) },
  (n) => ({ first: () => ({ json: n === 'Normalize Lead Payload'
    ? { lead_phone: '+15558675309', channel_source: 'sms' } : CAPS }) }),
  { id: 'w', name: 'wf' }, { id: 'e' })[0].json;
const logOk = rl.http_status === 429 && /lead 4\/4 per hour/.test(rl.error_message) && rl.severity === 'warning';
if (!logOk) fail++;
console.log('  ' + (logOk ? 'ok  ' : 'FAIL') + ' logs 429 naming the breached cap' + (logOk ? '' : ' -> ' + rl.error_message));

console.log(fail === 0 ? '\nSEND BUDGET TESTS PASS' : '\n' + fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);

/**
 * The public web-form webhook has no transport auth, so anyone who finds
 * /webhook/web-lead could previously supply a tenant id and an arbitrary phone
 * number and cause an SMS to be sent from that tenant's Twilio number to a
 * target of their choosing -- cost, spam, and TCPA exposure landing on the
 * client.
 *
 * "IF Intake Authorised" gates that path on a per-tenant shared secret and
 * fails closed. This asserts the gate blocks every abuse shape and lets
 * legitimate traffic through untouched.
 */
const fs = require('fs');
const wf = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const node = (n) => wf.nodes.find((x) => x.name === n);
let fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label.padEnd(52) + (got ? 'ALLOWED' : 'blocked') +
    (ok ? '' : '  (wanted ' + (want ? 'ALLOWED' : 'blocked') + ')'));
};

const normCode = node('Normalize Lead Payload').parameters.jsCode;
const normalize = (payload) => new Function('$input', '$execution', normCode)(
  { all: () => [{ json: payload }] }, { id: 'e1' })[0].json;

const gateExpr = node('IF Intake Authorised').parameters.conditions.conditions[0].leftValue
  .replace(/^=\{\{/, '').replace(/\}\}$/, '');
const allowed = (lead, cfg) => new Function('$json', '$', 'return (' + gateExpr + ')')(
  cfg, () => ({ first: () => ({ json: lead }) }));

const SECRET = 'a'.repeat(48);
const cfg = { client_id: 'test_client_001', webhook_secret: SECRET, twilio_phone_number: '+15005550006' };
const noSecretCfg = { client_id: 'test_client_001', webhook_secret: null, twilio_phone_number: '+15005550006' };

console.log('--- the attack this gate exists to stop ---');
check('web form, no secret (the original hole)',
  allowed(normalize({ body: { client_id: 'test_client_001', phone: '+15551110000' } }), cfg), false);
check('web form, wrong secret',
  allowed(normalize({ body: { client_id: 'test_client_001', phone: '+15551110000', secret: 'guess' } }), cfg), false);
check('web form, empty secret',
  allowed(normalize({ body: { client_id: 'test_client_001', phone: '+15551110000', secret: '' } }), cfg), false);
check('web form, correct secret but tenant has none (fail closed)',
  allowed(normalize({ body: { client_id: 'test_client_001', phone: '+15551110000', secret: SECRET } }), noSecretCfg), false);

console.log('--- legitimate traffic still flows ---');
check('web form, correct secret',
  allowed(normalize({ body: { client_id: 'test_client_001', phone: '+15551110000', secret: SECRET } }), cfg), true);
check('web form, secret sent as token',
  allowed(normalize({ body: { client_id: 'test_client_001', phone: '+15551110000', token: SECRET } }), cfg), true);

console.log('--- other channels are not gated by this rule ---');
check('inbound SMS',
  allowed(normalize({ body: { MessageSid: 'SM1', From: '+15558675309', To: '+15005550006', Body: 'hi' } }), cfg), true);
check('missed call',
  allowed(normalize({ body: { CallSid: 'CA1', CallStatus: 'no-answer', From: '+15558675309', To: '+15005550006', CallDuration: '0' } }), cfg), true);
check('IMAP lead email',
  allowed(normalize({ from: { text: 'a <a@b.com>' }, subject: 'New Lead', textPlain: 'call +15557776666', to: { value: [{ address: 'leads@biz.com' }] } }), cfg), true);
check('cold-lead follow-up sweep',
  allowed(normalize({ source: 'followup', client_id: 'test_client_001', phone: '+15558675309', client_phone: '+15005550006', followup_step: 1, message: 'x' }), cfg), true);

console.log('--- rejected intake is logged, not silently dropped ---');
const rej = new Function('$', '$workflow', '$execution', node('Flag Rejected Intake').parameters.jsCode)(
  () => ({ first: () => ({ json: normalize({ body: { client_id: 'test_client_001', phone: '+15551110000' } }) }) }),
  { id: 'w', name: 'wf' }, { id: 'e' })[0].json;
const logOk = rej.http_status === 401 && /no secret presented/.test(rej.error_message) && rej.severity === 'warning';
if (!logOk) fail++;
console.log('  ' + (logOk ? 'ok  ' : 'FAIL') + ' rejection writes a 401 warning to error_log');

console.log(fail === 0 ? '\nINTAKE AUTH TESTS PASS' : '\n' + fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);

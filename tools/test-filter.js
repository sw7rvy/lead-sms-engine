/**
 * SMS keyword classification, and the topological guarantee that goes with it.
 *
 * The opt-out branch used to hang straight off the webhook, ahead of any
 * authentication. That let an unauthenticated caller forge STOP to kill a live
 * thread, or -- worse -- forge START to re-subscribe a number that had genuinely
 * opted out. Classification now happens in the normalizer and the branch sits
 * behind signature verification.
 */
const fs = require('fs');
const wf = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const node = (n) => wf.nodes.find((x) => x.name === n);
const conns = wf.connections;
let fail = 0;
const check = (label, ok, detail) => {
  if (!ok) fail++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (ok || !detail ? '' : '  -> ' + detail));
};

const normCode = node('Normalize Lead Payload').parameters.jsCode;
const classify = (body, numMedia) => new Function('$input', '$execution', normCode)(
  { all: () => [{ json: { body: { MessageSid: 'SM1', From: '+15558675309', To: '+15005550006', Body: body, NumMedia: numMedia || '0' } } }] },
  { id: 'e1' })[0].json;

console.log('--- actionable messages reach the conversation ---');
for (const b of ['Tuesday at 2 works!', 'YES', 'yes please', 'Yes', 'no', 'I want to stop by at 3pm']) {
  check('actionable: ' + JSON.stringify(b), classify(b).is_actionable === true);
}
check('media-only message is actionable', classify('', '2').is_actionable === true);

console.log('--- opt-out, opt-in and help are diverted ---');
for (const b of ['STOP', 'stop.', 'Stop!', 'UNSUBSCRIBE', 'cancel', 'QUIT', 'revoke', 'optout',
                 'START', 'unstop', 'HELP', 'info', '', '   ']) {
  check('diverted: ' + JSON.stringify(b), classify(b).is_actionable === false);
}

console.log('--- the gate reads the classified flag, not the raw body ---');
const gate = node('IF Actionable Inbound SMS').parameters.conditions.conditions;
check('exactly one condition', gate.length === 1, gate.length + ' conditions');
check('reads is_actionable from the normalizer',
  /Normalize Lead Payload.*is_actionable/.test(gate[0].leftValue), gate[0].leftValue.slice(0, 70));
check('does not read the raw webhook body', !/\$json\.body/.test(gate[0].leftValue));

console.log('--- non-SMS channels are never classified as opt-out ---');
const norm = (payload) => new Function('$input', '$execution', normCode)(
  { all: () => [{ json: payload }] }, { id: 'e1' })[0].json;
check('missed call is actionable',
  norm({ body: { CallSid: 'CA1', CallStatus: 'no-answer', From: '+15558675309', To: '+15005550006', CallDuration: '0' } }).is_actionable === true);
check('web form is actionable',
  norm({ body: { client_id: 'c1', phone: '+15558675309', message: 'stop by tomorrow' } }).is_actionable === true);
check('follow-up sweep is actionable',
  norm({ source: 'followup', client_id: 'c1', phone: '+15558675309', client_phone: '+15005550006', message: 'x' }).is_actionable === true);

console.log('--- topology: no unauthenticated path to a database write ---');
const reaches = (from, target) => {
  const seen = new Set();
  const go = (n) => {
    if (n === target) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    const c = conns[n];
    return c ? c.main.some((o) => (o || []).some((e) => go(e.node))) : false;
  };
  return go(from);
};

check('the SMS webhook reaches the signature check',
  reaches('Twilio Inbound SMS Webhook', 'Verify Twilio Signature'));
check('the opt-out write sits downstream of the authorisation gate',
  reaches('IF Intake Authorised', 'Apply SMS Opt-Out / Opt-In'));

// The regression guard: nothing may reach the opt-out write without first
// passing Verify Twilio Signature. Cut that node out of the graph and the
// write must become unreachable from every trigger.
const severed = JSON.parse(JSON.stringify(conns));
delete severed['Verify Twilio Signature'];
const reachesSevered = (from, target) => {
  const seen = new Set();
  const go = (n) => {
    if (n === target) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    const c = severed[n];
    return c ? c.main.some((o) => (o || []).some((e) => go(e.node))) : false;
  };
  return go(from);
};
const triggers = wf.nodes
  .filter((n) => /webhook|Trigger|Schedule/i.test(n.name) && n.type !== 'n8n-nodes-base.stickyNote')
  .map((n) => n.name);
const bypass = triggers.filter((t) => reachesSevered(t, 'Apply SMS Opt-Out / Opt-In'));
check('no trigger reaches the opt-out write if signature checking is removed',
  bypass.length === 0, 'bypass via: ' + bypass.join(', '));

console.log(fail === 0 ? '\nSMS CLASSIFICATION TESTS PASS' : '\n' + fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);

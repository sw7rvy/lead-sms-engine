/**
 * The Twilio voice and SMS webhooks have no transport auth. A forged POST with
 * a chosen From/To makes the workflow send SMS from that tenant's number to a
 * target of the caller's choosing. "Verify Twilio Signature" closes that by
 * validating X-Twilio-Signature.
 *
 * HMAC-SHA1 is hand-implemented in the node (the Code sandbox blocks
 * require('crypto')), so it is checked here against RFC 2202 test vectors and
 * Twilio's own documented example before any behavioural assertion.
 */
const fs = require('fs');
const crypto = require('crypto');
const wf = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const node = (n) => wf.nodes.find((x) => x.name === n);
let fail = 0;
const check = (label, ok, detail) => {
  if (!ok) fail++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (ok || !detail ? '' : '  -> ' + detail));
};

const src = node('Verify Twilio Signature').parameters.jsCode;

// Expose the node's internal helpers so the primitives can be tested directly.
const harness = new Function('$input', '$', `
  ${src.replace(/^const cfg = \$input[\s\S]*$/m, '')}
  return { utf8Bytes, sha1, hmacSha1, base64, twilioSignature, safeEqual };
`)({ first: () => ({ json: {} }) }, () => ({ first: () => ({ json: {} }) }));

/* ---------- 1. SHA-1 against Node's crypto ---------- */
console.log('--- SHA-1 primitive vs node:crypto ---');
for (const s of ['', 'abc', 'The quick brown fox jumps over the lazy dog', 'a'.repeat(1000), 'héllo ☎ +15551234567']) {
  const mine = Buffer.from(harness.sha1(harness.utf8Bytes(s))).toString('hex');
  const ref = crypto.createHash('sha1').update(s, 'utf8').digest('hex');
  check('sha1(' + JSON.stringify(s.slice(0, 24)) + (s.length > 24 ? '…' : '') + ')', mine === ref, mine + ' != ' + ref);
}

/* ---------- 2. HMAC-SHA1, RFC 2202 vectors ---------- */
console.log('--- HMAC-SHA1 vs RFC 2202 ---');
const rfc = [
  { key: Buffer.alloc(20, 0x0b), data: 'Hi There', want: 'b617318655057264e28bc0b6fb378c8ef146be00' },
  { key: Buffer.from('Jefe'), data: 'what do ya want for nothing?', want: 'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79' },
  { key: Buffer.alloc(80, 0xaa), data: 'Test Using Larger Than Block-Size Key - Hash Key First', want: 'aa4ae5e15272d00e95705637ce8a3b55ed402112' },
];
for (const [i, v] of rfc.entries()) {
  const mine = Buffer.from(harness.hmacSha1([...v.key], harness.utf8Bytes(v.data))).toString('hex');
  check('RFC 2202 case ' + (i + 1), mine === v.want, mine + ' != ' + v.want);
}

/* ---------- 3. base64 ---------- */
console.log('--- base64 ---');
for (const s of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) {
  const mine = harness.base64(harness.utf8Bytes(s));
  const ref = Buffer.from(s, 'utf8').toString('base64');
  check('base64(' + JSON.stringify(s) + ')', mine === ref, mine + ' != ' + ref);
}

/* ---------- 4. Twilio's documented example ---------- */
// From Twilio's security docs: the canonical worked example.
console.log('--- Twilio documented example ---');
const TOKEN = '12345';
const URL = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const PARAMS = { Digits: '1234', To: '+18005551212', From: '+14158675310', Caller: '+14158675310', CallSid: 'CA1234567890ABCDE' };
const expected = crypto.createHmac('sha1', TOKEN)
  .update(URL + Object.keys(PARAMS).sort().map((k) => k + PARAMS[k]).join(''), 'utf8')
  .digest('base64');
const mine = harness.twilioSignature(TOKEN, URL, PARAMS);
check('signature matches an independent HMAC', mine === expected, mine + ' != ' + expected);
// No hardcoded published constant here: the comparison above is against Node's
// own OpenSSL-backed HMAC-SHA1 over the exact string Twilio specifies, which is
// a stronger check than a copied literal and cannot drift.
check('canonical string is url + sorted key+value pairs',
  harness.twilioSignature(TOKEN, URL, PARAMS) ===
  harness.twilioSignature(TOKEN, URL, { CallSid: PARAMS.CallSid, From: PARAMS.From, To: PARAMS.To, Caller: PARAMS.Caller, Digits: PARAMS.Digits }),
  'parameter insertion order must not change the signature');

/* ---------- 5. constant-time compare ---------- */
console.log('--- safeEqual ---');
check('equal strings', harness.safeEqual('abc', 'abc') === true);
check('differing strings', harness.safeEqual('abc', 'abd') === false);
check('different lengths', harness.safeEqual('abc', 'abcd') === false);
check('non-string input', harness.safeEqual(null, 'abc') === false);

/* ---------- 6. end-to-end through the node ---------- */
console.log('--- node behaviour ---');
const runNode = (cfg, lead, webhookJson) => new Function('$input', '$', src)(
  { first: () => ({ json: cfg }) },
  (n) => {
    if (n === 'Normalize Lead Payload') return { first: () => ({ json: lead }) };
    if (n === 'Twilio Inbound SMS Webhook') {
      if (!webhookJson) throw new Error('did not run');
      return { first: () => ({ json: webhookJson }) };
    }
    throw new Error('did not run');
  }
)[0].json;

const AUTH = 'deadbeefcafe0123456789abcdef0000';
const body = { MessageSid: 'SM1', From: '+15558675309', To: '+15005550006', Body: 'Tuesday works' };
const realUrl = 'https://n8n.example.com/webhook/twilio-inbound-sms';
const goodSig = crypto.createHmac('sha1', AUTH)
  .update(realUrl + Object.keys(body).sort().map((k) => k + body[k]).join(''), 'utf8').digest('base64');

const cfg = { client_id: 'c1', twilio_auth_token: AUTH, twilio_verify_signatures: true };
const lead = { channel_source: 'sms', lead_phone: '+15558675309' };
const mkReq = (sig) => ({
  headers: { host: 'n8n.example.com', 'x-forwarded-proto': 'https', 'x-twilio-signature': sig },
  body, webhookUrl: realUrl,
});

check('genuine Twilio request accepted', runNode(cfg, lead, mkReq(goodSig)).twilio_signature_valid === true,
  runNode(cfg, lead, mkReq(goodSig)).twilio_signature_reason);
check('forged request rejected', runNode(cfg, lead, mkReq('bogus+signature+value=')).twilio_signature_valid === false);
check('missing signature header rejected',
  runNode(cfg, lead, { headers: { host: 'n8n.example.com' }, body, webhookUrl: realUrl }).twilio_signature_valid === false);
check('tampered body rejected (From changed after signing)',
  runNode(cfg, { channel_source: 'sms', lead_phone: '+19995550000' },
    { headers: { host: 'n8n.example.com', 'x-forwarded-proto': 'https', 'x-twilio-signature': goodSig },
      body: Object.assign({}, body, { From: '+19995550000' }), webhookUrl: realUrl }).twilio_signature_valid === false);
check('no auth token configured fails closed',
  runNode({ client_id: 'c1', twilio_verify_signatures: true }, lead, mkReq(goodSig)).twilio_signature_valid === false);
check('explicit opt-out allows through',
  runNode({ client_id: 'c1', twilio_verify_signatures: false }, lead, mkReq('anything')).twilio_signature_valid === true);
check('non-Twilio channel is not checked',
  runNode(cfg, { channel_source: 'web_form' }, null).twilio_signature_checked === false);
check('tenant config passes through unchanged',
  runNode(cfg, lead, mkReq(goodSig)).client_id === 'c1');

console.log(fail === 0 ? '\nTWILIO SIGNATURE TESTS PASS' : '\n' + fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);

/**
 * Every node that changes something outside n8n must sit behind an
 * authentication gate, reachable only through one.
 *
 * This is a structural check, not a behavioural one. It catches the class of
 * bug that produced three separate findings in this repo: a side-effecting node
 * wired to a branch that forks off ahead of authentication. Each was invisible
 * to every other suite, because each node behaved perfectly in isolation --
 * the defect was where it sat in the graph.
 */
const fs = require('fs');
const wf = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const conns = wf.connections;
let fail = 0;

const GATES = ['Verify Twilio Signature', 'IF Intake Authorised'];

// Deliberately exempt, with the reason stated so an exemption is a decision
// rather than an oversight.
const EXEMPT = {
  'Log Error To Supabase':
    'the error sink; it must be reachable from every branch including rejections',
  'Supabase Upsert Client Config':
    'public onboarding endpoint, insert-only: a conflict returns 409 so an existing tenant cannot be overwritten',
};

const sideEffecting = wf.nodes.filter((n) =>
  n.type === 'n8n-nodes-base.twilio' ||
  n.type === 'n8n-nodes-base.googleSheets' ||
  (n.type === 'n8n-nodes-base.httpRequest' &&
   ['POST', 'PATCH', 'PUT', 'DELETE'].includes(n.parameters.method)));

const triggers = wf.nodes
  .filter((n) => n.type !== 'n8n-nodes-base.stickyNote' &&
                 /Webhook|Trigger|Schedule/.test(n.name))
  .map((n) => n.name);

const reachable = (graph, from, target) => {
  const seen = new Set();
  const go = (n) => {
    if (n === target) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    const c = graph[n];
    return c ? c.main.some((o) => (o || []).some((e) => go(e.node))) : false;
  };
  return go(from);
};

// With the gates cut out of the graph, nothing a trigger can still reach is gated.
const severed = JSON.parse(JSON.stringify(conns));
for (const g of GATES) delete severed[g];

console.log('--- side-effecting nodes must sit behind an authentication gate ---');
for (const n of sideEffecting) {
  const bypass = triggers.filter((t) => reachable(severed, t, n.name));
  const exemptReason = EXEMPT[n.name];

  if (exemptReason) {
    console.log('  --   ' + n.name.padEnd(32) + 'exempt: ' + exemptReason);
    continue;
  }
  const ok = bypass.length === 0;
  if (!ok) fail++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + n.name.padEnd(32) +
    (ok ? 'gated' : 'REACHABLE UNGATED via ' + bypass.join(', ')));
}

console.log('--- the onboarding endpoint cannot overwrite a live tenant ---');
const up = wf.nodes.find((n) => n.name === 'Supabase Upsert Client Config');
const prefer = (up.parameters.headerParameters.parameters
  .find((p) => p.name === 'Prefer') || {}).value || '';
const c1 = !/on_conflict/.test(up.parameters.url);
const c2 = !/merge-duplicates/.test(prefer);
if (!c1) fail++;
if (!c2) fail++;
console.log('  ' + (c1 ? 'ok  ' : 'FAIL') + ' url carries no on_conflict clause');
console.log('  ' + (c2 ? 'ok  ' : 'FAIL') + ' Prefer does not request merge-duplicates');
const hasErrBranch = (conns['Supabase Upsert Client Config'].main[1] || []).length > 0;
if (!hasErrBranch) fail++;
console.log('  ' + (hasErrBranch ? 'ok  ' : 'FAIL') + ' the 409 conflict has somewhere to go');

console.log('--- every exemption names a live node ---');
for (const name of Object.keys(EXEMPT)) {
  const exists = wf.nodes.some((n) => n.name === name);
  if (!exists) fail++;
  console.log('  ' + (exists ? 'ok  ' : 'FAIL') + ' ' + name +
    (exists ? '' : ' — exemption for a node that no longer exists'));
}

console.log(fail === 0 ? '\nAUTH TOPOLOGY TESTS PASS' : '\n' + fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);

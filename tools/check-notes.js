const wf = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const NEEDLE = String.fromCharCode(92) + 'n'; // a real backslash, then 'n'
let bad = 0;
for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.stickyNote')) {
  const c = n.parameters.content;
  const lit = c.split(NEEDLE).length - 1; // plain string search, no regex semantics
  const nl = (c.match(/\n/g) || []).length;
  if (lit) bad++;
  console.log('  ' + (lit ? 'BROKEN' : 'ok    ') + ' ' + n.name.padEnd(12) +
    'real newlines=' + String(nl).padEnd(3) + ' literal-backslash-n=' + lit);
}
console.log(bad ? bad + ' NOTES STILL BROKEN' : 'all ' + wf.nodes.filter((x) => x.type === 'n8n-nodes-base.stickyNote').length + ' sticky notes render correctly');
const s = wf.nodes.find((x) => x.name === 'Cold Lead Sweep Schedule');
console.log('schedule: every ' + s.parameters.rule.interval[0].minutesInterval + ' minutes');
process.exit(bad ? 1 : 0);

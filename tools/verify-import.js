const fs = require('fs');
const src = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const got = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const rt = Array.isArray(got) ? got[0] : got;
let bad = 0;
const check = (label, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) bad++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label.padEnd(26) +
    (ok ? String(a) : 'source=' + JSON.stringify(a) + ' imported=' + JSON.stringify(b)));
};

check('workflow name', src.name, rt.name);
check('node count', src.nodes.length, rt.nodes.length);

const srcNames = src.nodes.map((n) => n.name).sort();
const rtNames = rt.nodes.map((n) => n.name).sort();
check('node names identical', srcNames, rtNames);

// Every node type must resolve; an unresolved type imports but breaks at run time.
const srcTypes = src.nodes.map((n) => n.type + '@' + n.typeVersion).sort();
const rtTypes = rt.nodes.map((n) => n.type + '@' + n.typeVersion).sort();
check('types + typeVersions', srcTypes, rtTypes);

const edges = (w) => {
  const list = [];
  for (const [from, cfg] of Object.entries(w.connections || {})) {
    (cfg.main || []).forEach((outs, i) => (outs || []).forEach((c) => list.push(from + '#' + i + '->' + c.node)));
  }
  return list.sort();
};
const se = edges(src);
const re = edges(rt);
check('connection count', se.length, re.length);
check('connections identical', se, re);

// Code node bodies must survive byte-for-byte - an escaping bug here is silent.
for (const n of src.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
  const m = rt.nodes.find((x) => x.name === n.name);
  const ok = m && m.parameters.jsCode === n.parameters.jsCode && m.parameters.mode === n.parameters.mode;
  if (!ok) bad++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' code body: ' + n.name);
}

// Expressions must still be expressions.
let exprSrc = 0; let exprRt = 0;
const walk = (o, f) => {
  if (typeof o === 'string') { if (o.startsWith('=')) f(); return; }
  if (o && typeof o === 'object') Object.values(o).forEach((v) => walk(v, f));
};
src.nodes.forEach((n) => walk(n.parameters, () => exprSrc++));
rt.nodes.forEach((n) => walk(n.parameters, () => exprRt++));
check('n8n expressions', exprSrc, exprRt);

console.log(bad ? '\n' + bad + ' DIFFERENCE(S)' : '\nround-trip clean');
process.exit(bad ? 1 : 0);

// n8n exposes $json ONLY in runOnceForEachItem mode. Using it in
// runOnceForAllItems throws "$json is not defined" at runtime.
const wf = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const NEEDLE = '$' + 'json';
let bugs = 0;
for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
  const mode = n.parameters.mode;
  // Strip line comments - a comment mentioning $json is not a reference to it.
  const code = n.parameters.jsCode.split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
  const uses = code.includes(NEEDLE);
  const bad = uses && mode === 'runOnceForAllItems';
  if (bad) bugs++;
  console.log('  ' + (bad ? 'BUG ' : 'ok  ') + n.name.padEnd(28) + mode.padEnd(22) + 'uses $json: ' + uses);
}
console.log(bugs ? '\n' + bugs + ' node(s) would throw at runtime' : '\nno $json misuse');
process.exit(bugs ? 1 : 0);

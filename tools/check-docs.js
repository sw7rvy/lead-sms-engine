/**
 * Documentation that contradicts the artifact.
 *
 * This has already happened three times in this repo: the README claimed 37
 * functional nodes when there were 43, the landing page's stat tile said the
 * same, and tools/README.md both omitted four suites and told the reader to
 * ignore a checker warning that had been fixed. Each was written true and went
 * stale silently, because nothing compared the prose to the thing it described.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const wf = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let fail = 0;
const check = (label, ok, detail) => {
  if (!ok) fail++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (ok || !detail ? '' : '  -> ' + detail));
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const functional = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').length;

console.log('--- stated node counts match the workflow (' + functional + ' functional) ---');
const readme = read('README.md');
const m = readme.match(/(\d+)\s+functional nodes/);
check('README states a node count', !!m, 'no "N functional nodes" line found');
if (m) check('README count is current', Number(m[1]) === functional, m[1] + ' != ' + functional);

const page = read('docs/index.html');
const tile = page.match(/<b>(\d+)<\/b><span>workflow nodes<\/span>/);
check('landing page has a node stat tile', !!tile);
if (tile) check('landing page count is current', Number(tile[1]) === functional, tile[1] + ' != ' + functional);

console.log('--- every tool is documented in tools/README.md ---');
const toolsDoc = read('tools/README.md');
const scripts = fs.readdirSync(path.join(ROOT, 'tools'))
  .filter((f) => f.endsWith('.js'))
  .sort();
for (const s of scripts) {
  check(s, toolsDoc.includes('`' + s), 'absent from tools/README.md');
}

console.log('--- every suite in verify-all is documented, and vice versa ---');
const verifyAll = read('tools/verify-all.js');
const wired = [...verifyAll.matchAll(/run\('[^']+',\s*'([^']+)'/g)].map((x) => x[1]);
for (const s of scripts) {
  // build.js is the generator, verify-import/dryrun are manual tools.
  if (['build.js', 'verify-all.js', 'verify-import.js', 'dryrun.js', 'check-docs.js'].includes(s)) continue;
  check(s + ' is wired into verify-all', wired.includes(s), 'not run by verify-all.js');
}

console.log('--- no documented workaround for a fixed problem ---');
// validate.js stopped emitting this in 7e2ad9a; a doc telling people to ignore
// a checker is worse than no doc, so it must not outlive the warning.
const stale = 'UNEXPECTED SECOND OUTPUT';
const stillEmits = read('tools/validate.js').includes(stale);
const stillDocumented = toolsDoc.includes(stale);
check('tools/README does not document a warning validate.js no longer emits',
  !(stillDocumented && !stillEmits),
  'tools/README documents "' + stale + '" but validate.js can still produce it: ' + stillEmits);

console.log('--- the n8n version claim names a version that exists ---');
const ver = readme.match(/n8n \*\*([\d.]+)\*\*/);
check('README names a verified n8n version', !!ver, 'no version claim found');

console.log(fail === 0 ? '\nDOC CONSISTENCY TESTS PASS' : '\n' + fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);

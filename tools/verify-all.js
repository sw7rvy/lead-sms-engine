/**
 * Regenerate the workflow from build.js, then run every check against it.
 *
 *   node tools/verify-all.js            # rebuild + verify
 *   node tools/verify-all.js --check    # verify only, do not rebuild
 *
 * Exit code 0 = everything passed.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const TOOLS = __dirname;
const ROOT = path.resolve(TOOLS, '..');
const WF = path.join(ROOT, 'multi-channel-lead-sms-booking-engine.json');
const checkOnly = process.argv.includes('--check');

const run = (label, script, args, { tolerateExit } = {}) => {
  process.stdout.write('\n=== ' + label + ' ===\n');
  try {
    const outText = execFileSync(process.execPath, [path.join(TOOLS, script), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.stdout.write(outText);
    return true;
  } catch (e) {
    process.stdout.write((e.stdout || '') + (e.stderr || ''));
    // validate.js prints a known false positive for splitInBatches' two outputs.
    if (tolerateExit) return true;
    return false;
  }
};

let ok = true;

if (!checkOnly) {
  process.stdout.write('=== rebuild ===\n');
  try {
    process.stdout.write(execFileSync(process.execPath, [path.join(TOOLS, 'build.js'), WF], { encoding: 'utf8' }));
  } catch (e) {
    process.stdout.write((e.stdout || '') + (e.stderr || ''));
    console.error('BUILD FAILED');
    process.exit(1);
  }
}

if (!fs.existsSync(WF)) { console.error('missing ' + WF); process.exit(1); }

ok = run('structure', 'validate.js', [WF]) && ok;
ok = run('$json misuse audit', 'audit-json.js', [WF]) && ok;
ok = run('sticky notes', 'check-notes.js', [WF]) && ok;
ok = run('channel normalization', 'test-normalize.js', [WF]) && ok;
ok = run('opt-out filter', 'test-filter.js', [WF]) && ok;
ok = run('follow-up ladder', 'test-followup.js', [WF]) && ok;
ok = run('API contracts', 'test-calcom-payload.js', [WF]) && ok;
ok = run('intake authorisation', 'test-intake-auth.js', [WF]) && ok;
ok = run('twilio signature', 'test-twilio-signature.js', [WF]) && ok;
ok = run('send budget', 'test-send-budget.js', [WF]) && ok;
ok = run('auth topology', 'test-auth-topology.js', [WF]) && ok;

console.log('\n' + '='.repeat(60));
console.log(ok ? 'ALL CHECKS PASSED' : 'FAILURES - see above');
process.exit(ok ? 0 : 1);

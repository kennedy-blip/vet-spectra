/**
 * Browserless engine self-test runner.
 *
 * Runs the exact suite the Polyglot Admin Console executes in the browser and
 * exits non-zero on failure — used by CI before the web build.
 *
 *   node scripts/self-test.mjs
 */
import { runSelfTests } from '../src/lib/selftests/vetSelfTestSuite.js';

const { results, passed, total, totalMs } = await runSelfTests();

for (const r of results) {
	const mark = r.pass ? 'PASS' : 'FAIL';
	console.log(`${mark}  ${r.ms.toFixed(1).padStart(7)} ms  ${r.name}  |  ${r.actual}`);
}

console.log(`\n${passed}/${total} engine assertions passed in ${totalMs.toFixed(0)} ms`);

if (passed !== total) {
	console.error(`\n${total - passed} assertion(s) failed`);
	process.exit(1);
}

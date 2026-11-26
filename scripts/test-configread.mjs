// Unit tests for worker/configread.js (parsing the vision model's answer). Run: node scripts/test-configread.mjs
import { parseConfigAnswer, serialMatches } from '../worker/configread.js';
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) pass++; else { fail++; console.log('✗', m, extra ?? ''); } };

let r = parseConfigAnswer('{"is_config": true, "model": "TE310", "firmware": "A2.15.125 EZD", "serial": "TEBT25370550", "date": "2026/11/21", "non_reset_m": 10304, "reset_m": 10304, "bad_dot": 43}');
ok(r && r.non_reset_m === 10304 && r.serial === 'TEBT25370550' && r.bad_dot === 43 && r.firmware === 'A2.15.125 EZD', 'plain JSON');
r = parseConfigAnswer('Here is the data:\n```json\n{"is_config": true, "serial": "TEBT 2530 1666", "non_reset_m": "3,029", "reset_m": "3029 m", "bad_dot": "4"}\n```');
ok(r && r.non_reset_m === 3029 && r.reset_m === 3029 && r.serial === 'TEBT25301666' && r.bad_dot === 4, 'JSON inside prose, numbers as text');
ok(parseConfigAnswer('{"is_config": false}') === null, 'not a printout');
ok(parseConfigAnswer('I cannot see a printout.') === null, 'no JSON');
r = parseConfigAnswer({ is_config: true, serial: 'TEBT25440840', non_reset_m: null, reset_m: '12O0', bad_dot: null });
ok(r && r.non_reset_m === null && r.reset_m === null, 'unreadable / letter-in-number values become null', JSON.stringify(r));
ok(parseConfigAnswer({ is_config: true, model: 'TE310' }) === null, 'printout with no serial and no mileage is not used');
ok(serialMatches({ serial: 'TEBT25301554' }, 'tebt 25301554') === true, 'serial match ignores case and spaces');
ok(serialMatches({ serial: 'TEBT25301555' }, 'TEBT25301554') === false, 'different serial');
ok(serialMatches({ serial: null }, 'TEBT25301554') === null, 'serial not readable');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

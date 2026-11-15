import test from 'node:test';
import assert from 'node:assert/strict';
import { DebugLog } from '../../src/core/debuglog.js';

test('keeps only the newest entries and clips long text', () => {
  const log = new DebugLog(5);
  for (let i = 0; i < 12; i++) log.info('k', `entry ${i}`);
  assert.equal(log.entries.length, 5);
  assert.equal(log.entries[0].data, 'entry 7');
  log.error('big', 'x'.repeat(5000));
  assert.ok(log.entries.at(-1).data.length < 700);
});

test('serialises objects and survives circular data', () => {
  const log = new DebugLog();
  const a = { n: 1 }; a.self = a;
  log.info('obj', { holds: 3 });
  log.info('circ', a);
  assert.equal(log.entries[0].data, '{"holds":3}');
  assert.equal(typeof log.entries[1].data, 'string');
});

test('install() records console warnings/errors and can be removed', () => {
  const calls = [];
  const fake = { console: { warn: (...a) => calls.push(['warn', ...a]), error: (...a) => calls.push(['error', ...a]) }, addEventListener() {}, removeEventListener() {} };
  const log = new DebugLog();
  const off = log.install(fake);
  fake.console.warn('careful', 1);
  fake.console.error('boom');
  assert.deepEqual(log.entries.map((e) => [e.level, e.kind]), [['warn', 'console'], ['error', 'console']]);
  assert.equal(calls.length, 2, 'original console still called');
  off();
  fake.console.warn('after');
  assert.equal(log.entries.length, 2);
});

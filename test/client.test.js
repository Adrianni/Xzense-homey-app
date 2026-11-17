'use strict';

const assert = require('node:assert');
const test = require('node:test');
const { XzenseClient } = require('../lib/client');

/** A client whose "Bluetooth session" is a script, and whose waiting is free and counted. */
function setup(statuses) {
  const log = { writes: [], boosts: [], reads: 0, sleeps: 0 };
  const session = {
    globals: {},
    async setUserFanSpeed(percent) { log.writes.push(percent); },
    async setBoost(enabled) { log.boosts.push(enabled); },
    async readStatus() {
      log.reads += 1;
      const next = statuses.length > 1 ? statuses.shift() : statuses[0];
      return next;
    },
  };
  const client = new XzenseClient({}, { address: 'x', pin: 'ABCD' }, () => {}, {
    sleep: async () => { log.sleeps += 1; },
  });
  client.withSession = (fn) => fn(session);
  return { client, log };
}

const fan = (fanSpeed, deviceState = 4) => ({ deviceState, fanSpeed });

test('fan speed is written at once and followed until the fan arrives', async () => {
  const { client, log } = setup([fan(20), fan(25), fan(30)]);
  const result = await client.setFanSpeed(() => 30);
  assert.deepStrictEqual(log.writes, [30]);
  assert.strictEqual(log.reads, 3);
  assert.strictEqual(result.sent, 30);
  assert.strictEqual(result.status.fanSpeed, 30);
  assert.strictEqual(result.globals[0x50], 30);
});

test('a newer target is written straight away over the same connection', async () => {
  // The user keeps dragging: after the first reading the wanted speed has become 40.
  let wanted = 30;
  const { client, log } = setup([fan(20), fan(40)]);
  const originalRead = client.withSession;
  let reads = 0;
  client.withSession = (fn) => originalRead.call(client, async (session) => {
    const read = session.readStatus.bind(session);
    session.readStatus = async () => {
      const s = await read();
      reads += 1;
      if (reads === 1) wanted = 40; // change arrives while the first write is being followed
      return s;
    };
    return fn(session);
  });

  const result = await client.setFanSpeed(() => wanted);
  assert.deepStrictEqual(log.writes, [30, 40]);
  assert.strictEqual(log.sleeps, 0, 'the newer value must not wait for a sleep');
  assert.strictEqual(result.sent, 40);
});

test('a write is not repeated when the target has not changed', async () => {
  const { client, log } = setup([fan(10), fan(10), fan(35)]);
  await client.setFanSpeed(() => 35);
  assert.deepStrictEqual(log.writes, [35]);
});

test('following the fan gives up after a bounded number of readings', async () => {
  const { client, log } = setup([fan(20)]); // the fan never reaches 50
  const result = await client.setFanSpeed(() => 50);
  assert.strictEqual(log.reads, 8);
  assert.strictEqual(result.sent, 50);
});

test('boost on: read until the controller reports Boosting', async () => {
  const { client, log } = setup([fan(20, 4), fan(20, 4), fan(100, 3)]);
  const result = await client.setBoost(true);
  assert.deepStrictEqual(log.boosts, [true]);
  assert.strictEqual(log.reads, 3);
  assert.strictEqual(result.status.deviceState, 3);
});

test('boost off: read until the controller has left Boosting', async () => {
  const { client, log } = setup([fan(100, 3), fan(100, 3), fan(20, 4)]);
  const result = await client.setBoost(false);
  assert.deepStrictEqual(log.boosts, [false]);
  assert.strictEqual(log.reads, 3);
  assert.strictEqual(result.status.deviceState, 4);
});

test('boost stops waiting after a bounded number of readings', async () => {
  const { client, log } = setup([fan(20, 4)]); // never starts boosting
  await client.setBoost(true);
  assert.strictEqual(log.reads, 5);
});

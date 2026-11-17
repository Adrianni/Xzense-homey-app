'use strict';

const assert = require('node:assert');
const test = require('node:test');
const { XzenseClient } = require('../lib/client');
const P = require('../lib/protocol');

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
  assert.strictEqual(log.reads, 14);
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
  assert.strictEqual(log.reads, 9);
});


// ---------------------------------------------------------------------------------------------
// Connection handling, with a pretend controller that answers real frames
// ---------------------------------------------------------------------------------------------

function fakeController({ sendDump = true } = {}) {
  const calls = { find: 0, connect: 0, disconnect: 0, events: [] };
  const parser = new P.FrameParser();
  let notify = null;
  let fan = 20;
  let onDisconnect = null;

  const status = () => {
    const b = Buffer.alloc(14);
    b[0] = 4; // Operation
    b.writeInt16LE(fan, 3);
    b.writeInt16LE(900, 5);
    return b;
  };
  const reply = (packet, verb, body = Buffer.alloc(0)) => {
    notify(P.buildFrame(0x06, Buffer.concat([Buffer.from([packet, verb]), body])));
  };
  const respond = (frame) => {
    const body = frame.applicationPayload;
    if (frame.packetType === P.PACKET.CONNECT) {
      reply(P.PACKET.CONNECT, P.PROTOCOL.ACK, Buffer.from([1, 0, 0, 0, 47, 0, 14, 0]));
      if (sendDump) reply(P.PACKET.GLOBAL, P.PROTOCOL.DATA, Buffer.from([0x50, fan, 0]));
    } else if (frame.packetType === P.PACKET.STATUS) {
      reply(P.PACKET.STATUS, P.PROTOCOL.ACK, status());
    } else if (frame.packetType === P.PACKET.GLOBAL) {
      fan = body.readInt16LE(5); // session(4) id(1) value(2)
      reply(P.PACKET.GLOBAL, P.PROTOCOL.ACK);
    }
  };

  const characteristic = () => ({
    async write(data) { for (const f of parser.feed(Buffer.from(data))) respond(f); },
    async subscribeToNotifications(cb) { notify = cb; },
    async unsubscribeFromNotifications() {},
  });
  const peripheral = {
    async discoverAllServicesAndCharacteristics() {},
    async getService() { return { getCharacteristic: async () => characteristic() }; },
    async disconnect() { calls.disconnect += 1; calls.events.push('disconnect'); },
    on(event, cb) { if (event === 'disconnect') onDisconnect = cb; },
  };
  const homey = {
    ble: {
      async find() {
        calls.find += 1;
        return { connect: async () => { calls.connect += 1; return peripheral; } };
      },
    },
  };
  return { homey, calls, dropLink: () => onDisconnect && onDisconnect() };
}

function realClient(homey) {
  return new XzenseClient(homey, { address: 'x', pin: 'ABCD' }, () => {}, { sleep: async () => {} });
}

test('a kept-open connection is reused: the next change needs no reconnect', async () => {
  const { homey, calls } = fakeController();
  const client = realClient(homey);
  await client.setFanSpeed(() => 30, { keepAliveMs: 5000 });
  await client.setFanSpeed(() => 35, { keepAliveMs: 5000 });
  assert.strictEqual(calls.connect, 1);
  assert.strictEqual(calls.disconnect, 0, 'still open');
  await client.dispose();
  assert.strictEqual(calls.disconnect, 1);
});

test('without keep-alive every command connects and disconnects, but does not scan again', async () => {
  const { homey, calls } = fakeController();
  const client = realClient(homey);
  await client.setFanSpeed(() => 30);
  await client.setFanSpeed(() => 35);
  assert.strictEqual(calls.connect, 2);
  assert.strictEqual(calls.disconnect, 2);
  assert.strictEqual(calls.find, 1, 'the advertisement is reused');
});

test('a dropped link is replaced by a new connection', async () => {
  const { homey, calls, dropLink } = fakeController();
  const client = realClient(homey);
  await client.setFanSpeed(() => 30, { keepAliveMs: 5000 });
  dropLink();
  const result = await client.setFanSpeed(() => 35, { keepAliveMs: 0 });
  assert.strictEqual(calls.connect, 2);
  assert.strictEqual(result.status.fanSpeed, 35);
});

test('commands do not wait for the controller\'s GLOBAL dump', async () => {
  const { homey } = fakeController({ sendDump: false });
  const client = realClient(homey);
  const started = Date.now();
  await client.setFanSpeed(() => 30);
  assert.ok(Date.now() - started < 500, 'a command must not wait for a dump that readings need');
});

test('a reading is delivered before the connection is closed', async () => {
  const { homey, calls } = fakeController();
  const client = realClient(homey);
  await client.poll(undefined, () => calls.events.push('reading'));
  assert.deepStrictEqual(calls.events, ['reading', 'disconnect']);
});

test('readings are delivered while the fan is still on its way', async () => {
  const { homey } = fakeController();
  const client = realClient(homey);
  const seen = [];
  await client.setFanSpeed(() => 40, { onReading: (r) => seen.push(r.status.fanSpeed) });
  assert.ok(seen.length >= 1);
  assert.strictEqual(seen[seen.length - 1], 40);
});

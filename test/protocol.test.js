'use strict';

const assert = require('node:assert');
const test = require('node:test');
const P = require('../lib/protocol');
const vectors = require('./vectors.json');

const hex = (b) => Buffer.from(b).toString('hex');

test('frames match the recorded reference bytes', () => {
  assert.strictEqual(hex(P.buildConnectRequest('ABCD', 'Homey')), vectors.connect_ABCD);
  assert.strictEqual(hex(P.buildConnectRequest('2423', 'Homey')), vectors.connect_2423_escapes);
  assert.strictEqual(hex(P.buildConnectRequest('2327', 'Homey')), vectors.connect_2723_escapes);
  assert.strictEqual(hex(P.buildStatusRequest(0x4edb5f63)), vectors.status_plain);
  assert.strictEqual(hex(P.buildStatusRequest(0x24272300)), vectors.status_escapes);
  assert.strictEqual(hex(P.buildGlobalRequest(0x4edb5f63, 0x50, 20)), vectors.global_fan_20);
  assert.strictEqual(hex(P.buildGlobalRequest(0x4edb5f63, 0x50, -1)), vectors.global_neg);
  assert.strictEqual(hex(P.buildGlobalRequest(0x01020304, 0x50, 0x2423)), vectors.global_escape_value);
  assert.strictEqual(hex(P.buildBoostRequest(0x4edb5f63, true, 235)), vectors.boost_on);
  assert.strictEqual(hex(P.buildBoostRequest(0x4edb5f63, false, 235)), vectors.boost_off);
  assert.strictEqual(hex(P.buildVentilationRequest(0x4edb5f63, true)), vectors.ventilation_on);
  assert.strictEqual(hex(P.buildVentilationRequest(0x24272300, false)), vectors.ventilation_off);
});

test('parser round-trips frames, also when fragmented byte by byte', () => {
  for (const [name, h] of Object.entries(vectors)) {
    const raw = Buffer.from(h, 'hex');
    const whole = new P.FrameParser().feed(raw);
    assert.strictEqual(whole.length, 1, name);
    assert.strictEqual(hex(whole[0].raw), h, name);

    const parser = new P.FrameParser();
    let frames = [];
    for (const byte of raw) frames = frames.concat(parser.feed(Buffer.from([byte])));
    assert.strictEqual(frames.length, 1, `${name} (fragmented)`);
    assert.strictEqual(parser.crcErrors, 0, name);
  }
});

test('parser decodes request payload fields', () => {
  const [f] = new P.FrameParser().feed(Buffer.from(vectors.global_fan_20, 'hex'));
  assert.strictEqual(f.packetType, P.PACKET.GLOBAL);
  assert.strictEqual(f.protocolType, P.PROTOCOL.REQ);
  const p = f.applicationPayload;
  assert.strictEqual(p.readUInt32LE(0), 0x4edb5f63);
  assert.strictEqual(p[4], 0x50);
  assert.strictEqual(p.readInt16LE(5), 20);
});

test('corrupt CRC is rejected, garbage before a frame is skipped', () => {
  const good = Buffer.from(vectors.status_plain, 'hex');
  const bad = Buffer.from(good);
  bad[bad.length - 3] ^= 0xff;
  const parser = new P.FrameParser();
  assert.strictEqual(parser.feed(bad).length, 0);
  assert.strictEqual(parser.crcErrors, 1);
  const frames = parser.feed(Buffer.concat([Buffer.from([0x00, 0x11, 0x22]), good]));
  assert.strictEqual(frames.length, 1);
});

/** Build a controller -> client frame the same way the firmware does. */
function controllerFrame(packet, protocol, body) {
  return P.buildFrame(0x06, Buffer.concat([Buffer.from([packet, protocol]), body]));
}

test('STATUS/ACK decoding matches the live capture', () => {
  // Payload captured from the real controller: Boosting, 156 s, fan 100 %, chimney 45.0 C ...
  const body = Buffer.from('039c006400c201b8ffeb00c50300', 'hex');
  const frames = new P.FrameParser().feed(controllerFrame(P.PACKET.STATUS, P.PROTOCOL.ACK, body));
  const s = P.decodeStatus(frames[0], 0x1234);
  assert.deepStrictEqual(s, {
    deviceState: 3,
    stateTimer: 156,
    fanSpeed: 100,
    chimneyTemperature: 45.0,
    outsideTemperature: -7.2,
    insideTemperature: 23.5,
    airPressure: 965,
    flags: 0,
  });
  assert.strictEqual(P.deviceStateName(s.deviceState), 'Boosting');
});

test('CONNECT/ACK and CONNECT/NACK are recognised', () => {
  const ack = Buffer.from('a4b19bb52f000e00', 'hex'); // live capture payload
  const [a] = new P.FrameParser().feed(controllerFrame(P.PACKET.CONNECT, P.PROTOCOL.ACK, ack));
  assert.ok(a.isConnectAck);
  assert.strictEqual(a.sessionId, 0xb59bb1a4);
  const [n] = new P.FrameParser().feed(controllerFrame(P.PACKET.CONNECT, P.PROTOCOL.NACK, Buffer.alloc(0)));
  assert.ok(n.isConnectNack);
  assert.ok(!n.isConnectAck);
});

test('GLOBAL/DATA decoding (live dump excerpt)', () => {
  // Each entry is one id byte followed by a signed little-endian int16.
  const entries = Buffer.from([0x04, 57, 0, 0x1f, 40, 0, 0x50, 20, 0, 0x1e, 0x2c, 0x07]);
  const [f] = new P.FrameParser().feed(controllerFrame(P.PACKET.GLOBAL, P.PROTOCOL.DATA, entries));
  const g = P.decodeGlobals(f, 0x1234);
  assert.deepStrictEqual(g, { 4: 57, 31: 40, 80: 20, 30: 1836 });
});

test('boost and ventilation are mutually exclusive modes derived from the controller state', () => {
  assert.strictEqual(P.modeFromState(3), 'boost');
  assert.strictEqual(P.modeFromState(8), 'ventilation');
  for (const idle of [0, 1, 2, 4, 5, 6, 7, 9, 10]) assert.strictEqual(P.modeFromState(idle), 'off');
});

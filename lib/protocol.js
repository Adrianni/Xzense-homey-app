'use strict';

/*
 * Xzense BLE serial protocol: framing and message layouts.
 *
 * Everything here is written from the observable wire format, not from any vendor source:
 *
 *   frame   = SOF | size:u16le | network:u8 | type:u8 | payload | crc:u16le | EOF
 *   SOF     = 0x23, EOF = 0x24
 *   size    = number of bytes in (network + type + payload)
 *   crc     = CRC-16, poly 0x1021, init 0xFFFF, no reflection, no final xor, over (network + type + payload)
 *   escape  = inside payload and crc the bytes 0x23, 0x24 and 0x27 are sent as 0x27 followed by (byte | 0x80)
 *
 * The application messages used by this app travel in frames of type 0x06. Their payload starts with
 * a message id and a verb (request, ack, nack, data), followed by message specific fields.
 * All multi-byte numbers are little endian.
 */

const SOF = 0x23;
const EOF = 0x24;
const ESC = 0x27;

const NETWORK = 0x00;
const FRAME_TYPE_APP = 0x06;
const MAX_BODY_BYTES = 4096;

/** Message ids. */
const PACKET = Object.freeze({
  CONNECT: 0x02,
  GLOBAL: 0x06,
  STATUS: 0x07,
  BOOST: 0x08,
  VENTILATION: 0x09,
});

/** Verbs. */
const PROTOCOL = Object.freeze({
  DATA: 0x08,
  NACK: 0x09,
  ACK: 0x0a,
  REQ: 0x0b,
});

/** Register ids of the controller's "global" value table (signed 16 bit values). */
const GLOBAL = Object.freeze({
  PANEL_BATTERY_PERCENT: 0x04, // meaning inferred
  SIGNAL_STRENGTH: 0x05, // meaning and scale inferred
  DEVICE_STATE: 0x19,
  STATE_TIMER: 0x1a,
  AIR_PRESSURE: 0x1b,
  INSIDE_TEMP: 0x1c,
  OUTSIDE_TEMP: 0x1d,
  CHIMNEY_TEMP: 0x1e,
  FAN_SPEED: 0x1f,
  START_TEMP: 0x4b,
  STOP_TEMP: 0x4c,
  BOOST_TIME: 0x4d,
  AFTERRUN_TIME: 0x4e,
  BOOST_SPEED: 0x4f,
  USER_FAN_SPEED: 0x50,
  SYSTEM_CONTROL: 0x55,
  ALARM_SETPOINT: 0x58,
});

const DEVICE_STATE_NAMES = Object.freeze({
  0: 'Offline',
  1: 'Setup',
  2: 'Ready for lighting',
  3: 'Boosting',
  4: 'Operation',
  5: 'Burnout',
  6: 'Afterrun',
  7: 'Refueling',
  8: 'Ventilation',
  9: 'Error',
  10: 'Upgrading',
});

function deviceStateName(code) {
  if (code === null || code === undefined) return null;
  return DEVICE_STATE_NAMES[code] || `Unknown (${code})`;
}

// -------------------------------------------------------------------------------------------
// Checksum and escaping
// -------------------------------------------------------------------------------------------

function crc16CcittFalse(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function needsEscape(b) {
  return b === SOF || b === EOF || b === ESC;
}

function escapeBytes(bytes) {
  const out = [];
  for (const b of bytes) {
    if (needsEscape(b)) out.push(ESC, b | 0x80);
    else out.push(b);
  }
  return Buffer.from(out);
}

// -------------------------------------------------------------------------------------------
// Building frames and messages
// -------------------------------------------------------------------------------------------

function le16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function le16Signed(n) {
  const b = Buffer.alloc(2);
  b.writeInt16LE(n);
  return b;
}

function le32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/** Wrap a payload in a complete frame of the given frame type. */
function buildFrame(frameType, payload) {
  if (!Number.isInteger(frameType) || frameType < 0 || frameType > 0xff) {
    throw new RangeError('frame type must be one byte');
  }
  const body = Buffer.concat([Buffer.from([NETWORK, frameType]), payload]);
  if (body.length > 0xffff) throw new RangeError('frame body too large');

  return Buffer.concat([
    Buffer.from([SOF]),
    le16(body.length),
    body.subarray(0, 2), // network + type are never escaped
    escapeBytes(Buffer.concat([payload, le16(crc16CcittFalse(body))])),
    Buffer.from([EOF]),
  ]);
}

function requireSession(session) {
  if (!Number.isInteger(session) || session < 0 || session > 0xffffffff) {
    throw new RangeError('session id must be an unsigned 32 bit integer');
  }
}

function appFrame(packet, verb, ...fields) {
  return buildFrame(FRAME_TYPE_APP, Buffer.concat([Buffer.from([packet, verb]), ...fields]));
}

/**
 * Open a session. The PIN is four hex digits sent as a 16 bit number. The clock field is left at
 * zero so connecting never changes the controller's time.
 */
function buildConnectRequest(pin, clientName = 'Homey') {
  if (typeof pin !== 'string' || !/^[0-9a-f]{4}$/i.test(pin)) {
    throw new TypeError('PIN must be four hexadecimal digits');
  }
  const name = Buffer.from(clientName, 'ascii');
  if (name.length > 0xff) throw new RangeError('client name too long');
  return appFrame(
    PACKET.CONNECT,
    PROTOCOL.REQ,
    le16(parseInt(pin, 16)),
    Buffer.alloc(4),
    Buffer.from([name.length]),
    name,
  );
}

function buildStatusRequest(session) {
  requireSession(session);
  return appFrame(PACKET.STATUS, PROTOCOL.REQ, le32(session));
}

function buildGlobalRequest(session, registerId, value) {
  requireSession(session);
  if (!Number.isInteger(registerId) || registerId < 0 || registerId > 0xff) {
    throw new RangeError('register id must be one byte');
  }
  if (!Number.isInteger(value) || value < -0x8000 || value > 0x7fff) {
    throw new RangeError('value must be a signed 16 bit integer');
  }
  return appFrame(PACKET.GLOBAL, PROTOCOL.REQ, le32(session), Buffer.from([registerId]), le16Signed(value));
}

/** Start or stop boost. The request also carries the current inside temperature (tenths of a degree). */
function buildBoostRequest(session, enabled, insideTempTenths) {
  requireSession(session);
  if (!Number.isInteger(insideTempTenths) || insideTempTenths < -0x8000 || insideTempTenths > 0x7fff) {
    throw new RangeError('temperature must be a signed 16 bit integer');
  }
  return appFrame(
    PACKET.BOOST,
    PROTOCOL.REQ,
    le32(session),
    Buffer.from([enabled ? 1 : 0]),
    le16Signed(insideTempTenths),
  );
}

// -------------------------------------------------------------------------------------------
// Parsing frames
// -------------------------------------------------------------------------------------------

/** A checksum-verified frame with convenient views on the application message inside it. */
class XzenseFrame {
  constructor({ raw, size, networkProtocol, outerType, payload, checksum }) {
    Object.assign(this, { raw, size, networkProtocol, outerType, payload, checksum });
  }

  get packetType() { return this.payload.length > 0 ? this.payload[0] : null; }

  get protocolType() { return this.payload.length > 1 ? this.payload[1] : null; }

  get applicationPayload() { return this.payload.subarray(2); }

  _is(packet, verb) {
    return this.outerType === FRAME_TYPE_APP && this.packetType === packet && this.protocolType === verb;
  }

  get isConnectAck() { return this._is(PACKET.CONNECT, PROTOCOL.ACK) && this.applicationPayload.length >= 8; }

  get isConnectNack() { return this._is(PACKET.CONNECT, PROTOCOL.NACK); }

  /** Session id handed out by the controller (first four bytes of the connect ack). */
  get sessionId() { return this.isConnectAck ? this.applicationPayload.readUInt32LE(0) : null; }
}

/**
 * Try to read one frame that starts at `start` (which must hold SOF).
 * Returns { state: 'need-more' } when the buffer ends mid-frame, { state: 'bad' } when the bytes at
 * `start` cannot be the beginning of a valid frame, or { state: 'ok', frame, end } on success.
 */
function readFrameAt(buf, start) {
  if (buf.length - start < 5) return { state: 'need-more' };

  const size = buf.readUInt16LE(start + 1);
  if (size < 2 || size > MAX_BODY_BYTES) return { state: 'bad' };

  const networkProtocol = buf[start + 3];
  const outerType = buf[start + 4];

  // payload (size - 2 bytes) and crc (2 bytes) follow, with escaping applied
  const wanted = size;
  const tail = [];
  let pos = start + 5;
  while (tail.length < wanted) {
    if (pos >= buf.length) return { state: 'need-more' };
    if (buf[pos] === ESC) {
      if (pos + 1 >= buf.length) return { state: 'need-more' };
      tail.push(buf[pos + 1] & 0x7f);
      pos += 2;
    } else {
      tail.push(buf[pos]);
      pos += 1;
    }
  }

  if (pos >= buf.length) return { state: 'need-more' };
  if (buf[pos] !== EOF) return { state: 'bad' };

  const payload = Buffer.from(tail.slice(0, size - 2));
  const checksum = tail[size - 2] | (tail[size - 1] << 8);
  const body = Buffer.concat([Buffer.from([networkProtocol, outerType]), payload]);
  if (checksum !== crc16CcittFalse(body)) return { state: 'crc', end: pos + 1 };
  if (networkProtocol !== NETWORK) return { state: 'foreign', end: pos + 1 };

  return {
    state: 'ok',
    end: pos + 1,
    frame: new XzenseFrame({
      raw: Buffer.from(buf.subarray(start, pos + 1)),
      size,
      networkProtocol,
      outerType,
      payload,
      checksum,
    }),
  };
}

/** Collects BLE notification fragments and yields the complete, valid frames they contain. */
class FrameParser {
  constructor() {
    this.reset();
  }

  reset() {
    this._pending = Buffer.alloc(0);
    this.discardedBytes = 0;
    this.invalidFrames = 0;
    this.crcErrors = 0;
  }

  feed(data) {
    if (data && data.length) this._pending = Buffer.concat([this._pending, data]);
    const frames = [];

    for (;;) {
      const start = this._pending.indexOf(SOF);
      if (start < 0) {
        this.discardedBytes += this._pending.length;
        this._pending = Buffer.alloc(0);
        break;
      }
      if (start > 0) {
        this.discardedBytes += start;
        this._pending = this._pending.subarray(start);
      }

      const result = readFrameAt(this._pending, 0);
      if (result.state === 'need-more') break;

      if (result.state === 'ok') {
        frames.push(result.frame);
        this._pending = this._pending.subarray(result.end);
      } else if (result.state === 'bad') {
        // not a frame start after all: skip this SOF and look for the next one
        this.invalidFrames += 1;
        this.discardedBytes += 1;
        this._pending = this._pending.subarray(1);
      } else {
        // complete frame that failed validation: drop it as a whole
        this.invalidFrames += 1;
        if (result.state === 'crc') this.crcErrors += 1;
        this._pending = this._pending.subarray(result.end);
      }
    }
    return frames;
  }
}

// -------------------------------------------------------------------------------------------
// Decoding message contents
// -------------------------------------------------------------------------------------------

/** Strip a leading session id if the controller included one (the length tells which variant it is). */
function withoutSession(data, session, minLength) {
  if (session !== null && data.length >= minLength + 4 && data.readUInt32LE(0) === session) {
    return data.subarray(4);
  }
  return data;
}

/**
 * Status message (14 bytes): state u8, state timer i16, fan % i16, chimney, outside and inside
 * temperature as i16 tenths of a degree, air pressure i16 hPa, flags u8.
 */
function decodeStatus(frame, session = null) {
  const isStatus = frame.outerType === FRAME_TYPE_APP
    && frame.packetType === PACKET.STATUS
    && (frame.protocolType === PROTOCOL.DATA || frame.protocolType === PROTOCOL.ACK);
  if (!isStatus) return null;

  const data = withoutSession(frame.applicationPayload, session, 14);
  if (data.length < 14) return null;

  return {
    deviceState: data[0],
    stateTimer: data.readInt16LE(1),
    fanSpeed: data.readInt16LE(3),
    chimneyTemperature: data.readInt16LE(5) / 10,
    outsideTemperature: data.readInt16LE(7) / 10,
    insideTemperature: data.readInt16LE(9) / 10,
    airPressure: data.readInt16LE(11),
    flags: data[13],
  };
}

/** Global table dump: repeated (register id u8, value i16). Returns { id: value } or null. */
function decodeGlobals(frame, session = null) {
  const isDump = frame.outerType === FRAME_TYPE_APP
    && frame.packetType === PACKET.GLOBAL
    && frame.protocolType === PROTOCOL.DATA;
  if (!isDump) return null;

  let data = frame.applicationPayload;
  if (session !== null && data.length >= 4 && (data.length - 4) % 3 === 0
    && data.readUInt32LE(0) === session) {
    data = data.subarray(4);
  }
  if (data.length % 3 !== 0) return null;

  const values = {};
  for (let i = 0; i < data.length; i += 3) values[data[i]] = data.readInt16LE(i + 1);
  return values;
}

module.exports = {
  PACKET,
  PROTOCOL,
  GLOBAL,
  DEVICE_STATE_NAMES,
  deviceStateName,
  crc16CcittFalse,
  buildFrame,
  buildConnectRequest,
  buildStatusRequest,
  buildGlobalRequest,
  buildBoostRequest,
  FrameParser,
  decodeStatus,
  decodeGlobals,
};

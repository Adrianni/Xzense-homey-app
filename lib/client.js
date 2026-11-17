'use strict';

const P = require('./protocol');

// Dialog/Renesas DSPS (serial port over BLE). Homey normalises UUIDs to 32 lowercase hex chars.
const SERVICE_UUID = '0783b03e8535b5a07140a304d2495cb7';
const NOTIFY_UUID = '0783b03e8535b5a07140a304d2495cb8'; // controller -> client
const WRITE_UUID = '0783b03e8535b5a07140a304d2495cba'; // client -> controller

const CHUNK_SIZE = 20; // safe default ATT payload for write-without-response
const CHUNK_DELAY_MS = 10;
const CONNECT_ACK_TIMEOUT_MS = 10000;
const RESPONSE_TIMEOUT_MS = 8000;
const DUMP_WAIT_MS = 1500; // max wait for the controller's GLOBAL dump after connecting
const FOLLOW_INTERVAL_MS = 1500; // pause between readings while a change takes effect
const FAN_FOLLOW_READINGS = 14; // about 20 s: enough for the fan to ramp to a new speed
const BOOST_FOLLOW_READINGS = 8; // about 12 s

class XzenseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'XzenseError';
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One authenticated session with the controller.
 *
 * The controller accepts a single BLE client, so a session is short lived: connect, send
 * CONNECT with the PIN, do the work, disconnect. Use {@link XzenseClient.withSession}.
 */
class XzenseSession {
  constructor(peripheral, pin, log, onProgress) {
    this._peripheral = peripheral;
    this._progress = (step) => { try { if (onProgress) onProgress(step); } catch (err) { /* ignore */ } };
    this._pin = pin;
    this._log = log;
    this._parser = new P.FrameParser();
    this._waiters = [];
    this._writeChar = null;
    this._notifyChar = null;
    this.dead = false; // set when the Bluetooth link drops
    if (typeof peripheral.on === 'function') peripheral.on('disconnect', () => { this.dead = true; });
    this.sessionId = null;
    this.status = null; // latest decoded STATUS
    this.globals = {}; // latest GLOBAL values by id
  }

  async open({ wantGlobals = true } = {}) {
    const t = { start: Date.now() };
    this._progress('services');
    await this._peripheral.discoverAllServicesAndCharacteristics();
    const service = await this._peripheral.getService(SERVICE_UUID);
    if (!service) throw new XzenseError('Xzense service not found', 'NO_SERVICE');
    this._writeChar = await service.getCharacteristic(WRITE_UUID);
    this._notifyChar = await service.getCharacteristic(NOTIFY_UUID);
    if (!this._writeChar || !this._notifyChar) {
      throw new XzenseError('Xzense characteristics not found', 'NO_CHARACTERISTIC');
    }

    await this._notifyChar.subscribeToNotifications((data) => this._onData(data));
    t.subscribed = Date.now();

    this._progress('auth');
    const connect = this._waitFor((f) => f.isConnectAck || f.isConnectNack, CONNECT_ACK_TIMEOUT_MS);
    await this._send(P.buildConnectRequest(this._pin, 'Homey'));
    let frame;
    try {
      frame = await connect;
    } catch (err) {
      throw new XzenseError('No CONNECT response from controller', 'CONNECT_TIMEOUT');
    }
    if (frame.isConnectNack) throw new XzenseError('Controller rejected the PIN', 'BAD_PIN');
    this.sessionId = frame.sessionId;
    t.authed = Date.now();
    // The controller follows CONNECT/ACK with a GLOBAL dump (set points, battery, signal). Readings need it;
    // commands do not, so they skip the wait. Waiting ends as soon as the dump has arrived.
    if (wantGlobals && Object.keys(this.globals).length === 0) {
      await this._waitFor((f) => P.decodeGlobals(f, this.sessionId) !== null, DUMP_WAIT_MS).catch(() => {});
    }
    this._log(`timing open: discover+subscribe ${t.subscribed - t.start} ms, auth ${t.authed - t.subscribed} ms, `
      + `dump wait ${Date.now() - t.authed} ms`);
  }

  _onData(data) {
    for (const frame of this._parser.feed(Buffer.from(data))) {
      const status = P.decodeStatus(frame, this.sessionId);
      if (status) this.status = status;
      const globals = P.decodeGlobals(frame, this.sessionId);
      if (globals) Object.assign(this.globals, globals);

      const remaining = [];
      for (const w of this._waiters) {
        if (w.predicate(frame)) {
          clearTimeout(w.timer);
          w.resolve(frame);
        } else {
          remaining.push(w);
        }
      }
      this._waiters = remaining;
    }
  }

  _waitFor(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w !== waiter);
        reject(new XzenseError('Timed out waiting for controller response', 'TIMEOUT'));
      }, timeoutMs);
      this._waiters.push(waiter);
    });
  }

  async _send(frame) {
    for (let offset = 0; offset < frame.length; offset += CHUNK_SIZE) {
      await this._writeChar.write(frame.subarray(offset, offset + CHUNK_SIZE));
      if (offset + CHUNK_SIZE < frame.length) await sleep(CHUNK_DELAY_MS);
    }
  }

  /** Send a request and resolve with the ACK frame; rejects on NACK or timeout. */
  async _request(frame, packetType) {
    const response = this._waitFor(
      (f) => f.packetType === packetType
        && (f.protocolType === P.PROTOCOL.ACK || f.protocolType === P.PROTOCOL.NACK),
      RESPONSE_TIMEOUT_MS,
    );
    await this._send(frame);
    const ack = await response;
    if (ack.protocolType === P.PROTOCOL.NACK) {
      throw new XzenseError('Controller refused the request in its current state', 'NACK');
    }
    return ack;
  }

  /** Request a fresh STATUS frame and return it decoded. */
  async readStatus() {
    this.status = null;
    const frame = await this._request(P.buildStatusRequest(this.sessionId), P.PACKET.STATUS);
    const status = P.decodeStatus(frame, this.sessionId);
    if (!status) throw new XzenseError('Invalid STATUS response', 'BAD_STATUS');
    this.status = status;
    return status;
  }

  /** Write a GLOBAL register (signed 16-bit). */
  async writeGlobal(globalId, value) {
    await this._request(P.buildGlobalRequest(this.sessionId, globalId, value), P.PACKET.GLOBAL);
  }

  async setUserFanSpeed(percent) {
    await this.writeGlobal(P.GLOBAL.USER_FAN_SPEED, Math.round(percent));
  }

  /** Start/stop boost; the request carries the current inside temperature (raw, x10). */
  async setBoost(enabled) {
    const status = this.status || (await this.readStatus());
    const insideRaw = Math.round(status.insideTemperature * 10);
    await this._request(
      P.buildBoostRequest(this.sessionId, enabled, insideRaw),
      P.PACKET.BOOST,
    );
  }

  async close() {
    for (const w of this._waiters) clearTimeout(w.timer);
    this._waiters = [];
    try {
      if (this._notifyChar) await this._notifyChar.unsubscribeFromNotifications();
    } catch (err) {
      // ignore: the link may already be gone
    }
    try {
      await this._peripheral.disconnect();
    } catch (err) {
      // ignore
    }
  }
}

class XzenseClient {
  /**
   * @param {object} homey  Homey instance (`this.homey` in app/driver/device)
   * @param {object} opts   { address: BLE address/uuid of the controller, pin: 4 hex digits }
   * @param {Function} log  logger
   */
  constructor(homey, { address, pin }, log = () => {}, { sleep: sleepFn = sleep } = {}) {
    this._sleep = sleepFn;
    this._homey = homey;
    this._address = address;
    this._pin = pin;
    this._log = log;
    this._queue = Promise.resolve();
    this._live = null; // { session, timer }: a connection kept open after a command
    this._advertisement = null; // last advertisement, reused so reconnecting does not need a new scan
  }

  /**
   * Run `fn(session)` inside one BLE session. Calls are serialised because the controller only
   * accepts a single client at a time.
   *
   * Options: `keepAliveMs` keeps the connection open for that long afterwards, so the next call (for
   * example the next slider change) skips find/connect/authenticate and is instant. `wantGlobals`
   * waits for the controller's GLOBAL dump when connecting (readings need it, commands do not).
   */
  withSession(fn, onProgress, options = {}) {
    const run = this._queue.then(() => this._runSession(fn, onProgress, options));
    this._queue = run.catch(() => {});
    return run;
  }

  async _runSession(fn, onProgress, { keepAliveMs = 0, wantGlobals = true } = {}) {
    // 1) reuse a connection that an earlier command kept open
    const live = this._live;
    this._live = null;
    if (live) {
      clearTimeout(live.timer);
      if (!live.session.dead) {
        try {
          this._log('reusing the open connection');
          const result = await fn(live.session);
          await this._keepOrClose(live.session, keepAliveMs);
          return result;
        } catch (err) {
          if (err instanceof XzenseError && err.code === 'NACK') {
            await this._keepOrClose(live.session, keepAliveMs); // the link is fine, the controller just said no
            throw err;
          }
          this._log('kept connection failed, reconnecting:', err.message);
        }
      }
      await live.session.close();
    }

    // 2) open a new connection
    const session = await this._connect(onProgress);
    try {
      await session.open({ wantGlobals });
      const result = await fn(session);
      await this._keepOrClose(session, keepAliveMs);
      return result;
    } catch (err) {
      await session.close();
      throw err;
    }
  }

  /** Find the controller (or reuse the last advertisement) and open a Bluetooth link to it. */
  async _connect(onProgress) {
    const progress = (step) => { try { if (onProgress) onProgress(step); } catch (err) { /* ignore */ } };
    const t0 = Date.now();
    let peripheral = null;

    if (this._advertisement) {
      progress('connect');
      try {
        peripheral = await this._advertisement.connect();
      } catch (err) {
        this._log('reusing the last advertisement failed, scanning again:', err.message);
        this._advertisement = null;
      }
    }
    if (!peripheral) {
      progress('find');
      const advertisement = await this._homey.ble.find(this._address);
      if (!advertisement) throw new XzenseError('Xzense not found', 'NOT_FOUND');
      this._advertisement = advertisement;
      progress('connect');
      peripheral = await advertisement.connect();
    }
    this._log(`timing: find+connect ${Date.now() - t0} ms`);
    return new XzenseSession(peripheral, this._pin, this._log);
  }

  async _keepOrClose(session, keepAliveMs) {
    if (keepAliveMs > 0 && !session.dead) {
      const timer = setTimeout(() => {
        if (this._live && this._live.session === session) this._live = null;
        session.close();
      }, keepAliveMs);
      if (timer.unref) timer.unref();
      this._live = { session, timer };
    } else {
      await session.close();
    }
  }

  /** Close a connection that is being kept open (call when the device goes away). */
  async dispose() {
    const live = this._live;
    this._live = null;
    if (live) {
      clearTimeout(live.timer);
      await live.session.close();
    }
  }

  /**
   * Connect with the PIN, read STATUS and the GLOBAL dump, disconnect. The reading is passed to
   * `onReading` as soon as it is in, before the (slow) disconnect.
   */
  poll(onProgress, onReading) {
    return this.withSession(async (session) => {
      if (onProgress) onProgress('read');
      const status = await session.readStatus();
      const reading = { status, globals: { ...session.globals } };
      this._emit(onReading, reading);
      return reading;
    }, onProgress, { wantGlobals: true });
  }

  /**
   * Set the fan speed and follow it until the fan has arrived (the controller acknowledges at once,
   * but the fan needs several seconds to ramp). `getTarget()` returns the wanted speed and is asked
   * again between readings: if a newer value has arrived (the user kept dragging) it is written
   * straight away over the same connection. Every reading is passed to `onReading` as it comes in, so
   * the screen follows the fan instead of waiting for the end. Waits at most about 20 seconds.
   *
   * Resolves with { status, globals, sent } where `sent` is the last speed written.
   */
  setFanSpeed(getTarget, { onReading, keepAliveMs = 0 } = {}) {
    return this.withSession(async (session) => {
      let sent = null;
      let status = null;
      for (let i = 0; i < FAN_FOLLOW_READINGS; i++) {
        const target = getTarget();
        if (target !== sent) {
          await session.setUserFanSpeed(target);
          sent = target;
          this._log(`fan: wrote ${target}`);
        }
        status = await session.readStatus();
        this._log(`fan: reading ${status.fanSpeed} (target ${sent})`);
        this._emit(onReading, { status, globals: { ...session.globals, [P.GLOBAL.USER_FAN_SPEED]: sent } });
        if (getTarget() !== sent) continue; // a newer value arrived: write it at once
        if (status.fanSpeed === sent) break;
        await this._sleep(FOLLOW_INTERVAL_MS);
      }
      return { status, sent, globals: { ...session.globals, [P.GLOBAL.USER_FAN_SPEED]: sent } };
    }, undefined, { keepAliveMs, wantGlobals: false });
  }

  /** Start or stop boost, then read status until the controller has changed state (at most ~12 s). */
  setBoost(enabled, { onReading, keepAliveMs = 0 } = {}) {
    return this.withSession(async (session) => {
      await session.setBoost(enabled);
      const reached = (s) => (s.deviceState === 3) === enabled; // 3 = Boosting
      let status = await session.readStatus();
      this._emit(onReading, { status, globals: { ...session.globals } });
      for (let i = 0; i < BOOST_FOLLOW_READINGS && !reached(status); i++) {
        await this._sleep(FOLLOW_INTERVAL_MS);
        status = await session.readStatus();
        this._emit(onReading, { status, globals: { ...session.globals } });
      }
      return { status, globals: { ...session.globals } };
    }, undefined, { keepAliveMs, wantGlobals: false });
  }

  _emit(onReading, reading) {
    if (!onReading) return;
    try {
      const pending = onReading(reading);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (err) {
      // a display problem must never break the command
    }
  }
}

module.exports = {
  XzenseClient,
  XzenseSession,
  XzenseError,
  SERVICE_UUID,
  NOTIFY_UUID,
  WRITE_UUID,
};

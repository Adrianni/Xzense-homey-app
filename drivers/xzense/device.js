'use strict';

const Homey = require('homey');
const { XzenseClient, XzenseError } = require('../../lib/client');
const P = require('../../lib/protocol');

const RETRY_DELAY_MS = 30000;
const FAN_DEBOUNCE_MS = 800; // slider or widget changes within this window are sent as one command

const REQUIRED_CAPABILITIES = ['xzense_fan_setpoint', 'measure_xzense_fan_speed', 'xzense_boost_mode'];

// Order of the sensors on the device's sensor tab: Homey lists them in the order they were added.
const SENSOR_ORDER = [
  'xzense_state',
  'measure_xzense_fan_speed',
  'measure_temperature.chimney',
  'measure_temperature.inside',
  'measure_temperature.outside',
  'measure_pressure',
  'alarm_heat',
  'xzense_panel_battery',
  'xzense_signal',
];

class XzenseDevice extends Homey.Device {
  async onInit() {
    this._pollTimer = null;
    this._fanTimer = null;
    this._stopped = false;
    this._deviceState = null;
    this._knownSetpoint = null; // last fan setpoint confirmed by the controller (GLOBAL 0x50)
    this._targetFan = null; // pending fan setpoint (percent) not yet sent to the controller

    await this._migrateCapabilities();
    await this._applyFanOptions();

    this._client = new XzenseClient(
      this.homey,
      { address: this.getData().id, pin: this.getStoreValue('pin') },
      this.log.bind(this),
    );

    // The slider sets the fan speed. Dragging fires many events, so they are debounced into one command.
    this.registerCapabilityListener('xzense_fan_setpoint', async (value) => {
      this._queueFan(this._clampFanSpeed(Math.round(Number(value) * 100)));
    });
    // Boost is a picker with two choices ("Boost av" / "Boost på"); Homey highlights the current one.
    this.registerCapabilityListener('xzense_boost_mode', async (value) => {
      await this._runCommand(() => this._client.setBoost(value === 'on'));
    });

    this._schedulePoll(1000);
  }

  async _migrateCapabilities() {
    for (const id of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(id)) {
        this.log(`Adding capability ${id}`);
        await this.addCapability(id).catch((err) => this.error(`addCapability ${id} failed:`, err.message));
      }
    }
    await this._ensureSensorOrder();
    this.log('Capabilities:', this.getCapabilities().join(', '));
  }

  /**
   * Homey shows sensors in the order they were added to the device. If the order differs from
   * SENSOR_ORDER, remove the sensors from the first difference onwards and add them back in order,
   * keeping their last values so nothing is blank until the next reading.
   */
  async _ensureSensorOrder() {
    const current = this.getCapabilities().filter((id) => SENSOR_ORDER.includes(id));
    const firstDiff = SENSOR_ORDER.findIndex((id, i) => current[i] !== id);
    if (firstDiff < 0) return;

    const toRedo = SENSOR_ORDER.slice(firstDiff);
    this.log(`Reordering sensors from ${toRedo[0]}`);
    const values = {};
    for (const id of toRedo) {
      if (this.hasCapability(id)) values[id] = this.getCapabilityValue(id);
    }
    for (const id of current.slice(firstDiff)) {
      await this.removeCapability(id).catch((err) => this.error(`removeCapability ${id} failed:`, err.message));
    }
    for (const id of toRedo) {
      if (!this.hasCapability(id)) {
        await this.addCapability(id).catch((err) => this.error(`addCapability ${id} failed:`, err.message));
      }
      if (values[id] !== undefined && values[id] !== null) {
        await this.setCapabilityValue(id, values[id]).catch(this.error);
      }
    }
  }

  get deviceState() {
    return this._deviceState;
  }

  // ---------------------------------------------------------------------------------------
  // Fan state shared with the dashboard widget
  // ---------------------------------------------------------------------------------------

  /** Everything the widget needs to draw itself. */
  getFanState() {
    const min = Number(this.getSetting('min_fan_speed') ?? 0);
    const max = Number(this.getSetting('max_fan_speed') ?? 100);
    return {
      id: this.getData().id,
      name: this.getName(),
      available: this.getAvailable(),
      now: this.getCapabilityValue('measure_xzense_fan_speed'),
      set: this._targetFan ?? this._setpointPercent(),
      pending: this._targetFan !== null,
      state: this.getCapabilityValue('xzense_state'),
      step: this._fanStep(),
      min,
      max: Math.max(min, max),
    };
  }

  _emitFanState() {
    try {
      this.homey.api.realtime('xzense.fan', this.getFanState());
    } catch (err) {
      // realtime is best-effort; the widget also polls
    }
  }

  /** Called by the dashboard widget buttons: one step up or down. Returns the new state at once. */
  adjustFan(direction) {
    this._adjustFan(direction);
    return this.getFanState();
  }

  /** Slider range and step follow the device settings (min/max fan speed, step). */
  async _applyFanOptions() {
    const min = Number(this.getSetting('min_fan_speed') ?? 0);
    const max = Number(this.getSetting('max_fan_speed') ?? 100);
    // The slider works on a 0..1 fraction (Homey shows it as %), see the capability definition.
    await this.setCapabilityOptions('xzense_fan_setpoint', {
      min: min / 100,
      max: Math.max(min, max) / 100,
      step: this._fanStep() / 100,
      decimals: 2,
    }).catch(this.error);
  }

  /** The slider capability holds a 0..1 fraction; return it as whole percent (null if unknown). */
  _setpointPercent() {
    const value = this.getCapabilityValue('xzense_fan_setpoint');
    return value === null || value === undefined ? null : Math.round(Number(value) * 100);
  }

  _fanStep() {
    return Math.max(1, Math.round(Number(this.getSetting('fan_step') || 5)));
  }

  _clampFanSpeed(value) {
    const min = Number(this.getSetting('min_fan_speed') ?? 0);
    const max = Number(this.getSetting('max_fan_speed') ?? 100);
    return Math.round(Math.min(Math.max(Number(value), min), Math.max(min, max)));
  }

  /**
   * Widget button. Updates the "set" value on screen at once and sends one command after the
   * last tap, so quick repeated taps add up instead of racing each other.
   */
  _adjustFan(direction) {
    const base = this._targetFan ?? this._knownSetpoint ?? this._setpointPercent();
    if (base === null || base === undefined) {
      throw new Error('The current fan setting is not known yet. Try again in a moment.');
    }
    this._queueFan(this._clampFanSpeed(Number(base) + direction * this._fanStep()));
  }

  _queueFan(target) {
    this._targetFan = target;
    this.setCapabilityValue('xzense_fan_setpoint', target / 100).catch(this.error);
    this._emitFanState();

    if (this._fanTimer) this.homey.clearTimeout(this._fanTimer);
    this._fanTimer = this.homey.setTimeout(() => this._sendPendingFan(), FAN_DEBOUNCE_MS);
  }

  async _sendPendingFan() {
    const target = this._targetFan;
    this._fanTimer = null;
    if (target === null) return;
    try {
      await this._runCommand(() => this._client.setFanSpeed(target));
    } catch (err) {
      // _runCommand already logged; show the controller's real value again.
      if (this._knownSetpoint !== null) {
        await this.setCapabilityValue('xzense_fan_setpoint', this._knownSetpoint / 100).catch(this.error);
      }
      await this.setWarning(err.message).catch(this.error);
    } finally {
      if (this._targetFan === target) this._targetFan = null;
      this._emitFanState();
    }
  }

  /** Called by the "Set fan speed" flow card. */
  async setFanSpeed(percent) {
    const target = this._clampFanSpeed(percent);
    this._targetFan = target;
    await this.setCapabilityValue('xzense_fan_setpoint', target / 100).catch(this.error);
    this._emitFanState();
    if (this._fanTimer) {
      this.homey.clearTimeout(this._fanTimer);
      this._fanTimer = null;
    }
    try {
      await this._runCommand(() => this._client.setFanSpeed(target));
    } finally {
      if (this._targetFan === target) this._targetFan = null;
      this._emitFanState();
    }
  }

  async setBoost(enabled) {
    await this._runCommand(() => this._client.setBoost(Boolean(enabled)));
  }

  async _runCommand(action) {
    try {
      const result = await action();
      await this._applyReading(result);
      await this.setAvailable().catch(this.error);
      await this.unsetWarning().catch(this.error);
    } catch (err) {
      this.error('Command failed:', err.message);
      throw new Error(this._userMessage(err));
    }
  }

  _userMessage(err) {
    if (err instanceof XzenseError) {
      switch (err.code) {
        case 'BAD_PIN': return 'The controller rejected the PIN.';
        case 'NACK': return 'The controller refused the command in its current state.';
        case 'NOT_FOUND': return 'Xzense controller not found nearby.';
        default: return err.message;
      }
    }
    return err.message || String(err);
  }

  _pollIntervalMs() {
    const idle = Math.max(30, Number(this.getSetting('poll_interval') || 60));
    // While the fireplace is running (boost, operation, burnout, afterrun, refuel, ventilation)
    // poll faster so the values stay live.
    const active = Math.max(30, Number(this.getSetting('active_poll_interval') || 30));
    const running = [3, 4, 5, 6, 7, 8].includes(this._deviceState);
    return (running ? Math.min(idle, active) : idle) * 1000;
  }

  _schedulePoll(delayMs) {
    if (this._stopped) return;
    if (this._pollTimer) this.homey.clearTimeout(this._pollTimer);
    this._pollTimer = this.homey.setTimeout(() => this._poll(), delayMs);
  }

  async _poll() {
    if (this._stopped) return;
    try {
      const result = await this._client.poll();
      await this._applyReading(result);
      await this.setAvailable().catch(this.error);
      this._schedulePoll(this._pollIntervalMs());
    } catch (err) {
      this.error('Poll failed:', err.message);
      if (err instanceof XzenseError && err.code === 'BAD_PIN') {
        // Never keep retrying a rejected PIN: the controller may lock out repeated failures.
        await this.setUnavailable('The controller rejected the PIN. Remove and re-add the device.').catch(this.error);
        return;
      }
      await this.setUnavailable(this._userMessage(err)).catch(this.error);
      this._schedulePoll(Math.max(RETRY_DELAY_MS, this._pollIntervalMs()));
    } finally {
      this._emitFanState();
    }
  }

  async _applyReading({ status, globals }) {
    const set = (id, value) => this.setCapabilityValue(id, value).catch(this.error);

    await set('measure_temperature.chimney', status.chimneyTemperature);
    await set('measure_temperature.inside', status.insideTemperature);
    await set('measure_temperature.outside', status.outsideTemperature);
    await set('measure_pressure', status.airPressure);
    await set('measure_xzense_fan_speed', status.fanSpeed);
    const boosting = status.deviceState === 3; // 3 = Boosting
    await set('xzense_boost_mode', boosting ? 'on' : 'off');
    await set('xzense_state', P.deviceStateName(status.deviceState));
    await set('alarm_heat', status.chimneyTemperature >= Number(this.getSetting('chimney_alarm_temp') || 220));

    const setpoint = globals[P.GLOBAL.USER_FAN_SPEED];
    if (setpoint !== undefined) {
      this._knownSetpoint = setpoint;
      // Do not overwrite the on-screen value while a change is still waiting to be sent.
      if (this._targetFan === null) await set('xzense_fan_setpoint', setpoint / 100);
    }
    if (globals[P.GLOBAL.PANEL_BATTERY_PERCENT] !== undefined) {
      await set('xzense_panel_battery', globals[P.GLOBAL.PANEL_BATTERY_PERCENT]);
    }
    if (globals[P.GLOBAL.SIGNAL_STRENGTH] !== undefined) {
      await set('xzense_signal', globals[P.GLOBAL.SIGNAL_STRENGTH]);
    }
    this._emitFanState();

    if (this._deviceState !== status.deviceState) {
      const previous = this._deviceState;
      this._deviceState = status.deviceState;
      if (previous !== null) {
        const card = this.homey.flow.getDeviceTriggerCard('state_changed');
        await card
          .trigger(this, { state: P.deviceStateName(status.deviceState) }, { state: String(status.deviceState) })
          .catch(this.error);
      }
    }
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('poll_interval') || changedKeys.includes('active_poll_interval')) {
      this._schedulePoll(this._pollIntervalMs());
    }
    if (['fan_step', 'min_fan_speed', 'max_fan_speed'].some((k) => changedKeys.includes(k))) {
      // Settings are applied after this handler returns; tell the widget a moment later.
      this.homey.setTimeout(() => {
        this._applyFanOptions();
        this._emitFanState();
      }, 500);
    }
  }

  _clearTimers() {
    this._stopped = true;
    if (this._pollTimer) this.homey.clearTimeout(this._pollTimer);
    if (this._fanTimer) this.homey.clearTimeout(this._fanTimer);
  }

  async onDeleted() {
    this._clearTimers();
  }

  async onUninit() {
    this._clearTimers();
  }
}

module.exports = XzenseDevice;

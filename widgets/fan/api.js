'use strict';

function findDevice(homey, id) {
  const driver = homey.drivers.getDriver('xzense');
  return driver.getDevices().find((device) => device.getData().id === id);
}

function requireDevice(homey, id) {
  if (!id) throw new Error('No controller selected in the widget settings.');
  const device = findDevice(homey, id);
  if (!device) throw new Error('Controller not found. Check the widget settings.');
  return device;
}

module.exports = {
  /** GET /state?deviceId=... – the current fan state. */
  async getState({ homey, query }) {
    return requireDevice(homey, query.deviceId).getFanState();
  },

  /** POST /adjust { deviceId, direction: 'up' | 'down' } – one step; returns the new state at once. */
  async adjust({ homey, body }) {
    const device = requireDevice(homey, body && body.deviceId);
    const direction = body && body.direction === 'up' ? +1 : -1;
    return device.adjustFan(direction);
  },
};

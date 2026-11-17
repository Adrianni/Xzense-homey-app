'use strict';

const Homey = require('homey');

class XzenseApp extends Homey.App {
  async onInit() {
    this.homey.flow.getActionCard('set_fan_speed').registerRunListener(
      async ({ device, speed }) => device.setFanSpeed(speed),
    );
    this.homey.flow.getActionCard('set_mode').registerRunListener(
      async ({ device, mode }) => device.setMode(mode),
    );

    this.homey.flow.getConditionCard('state_is').registerRunListener(
      async ({ device, state }) => String(device.deviceState) === String(state),
    );

    this.homey.flow.getDeviceTriggerCard('state_changed').registerRunListener(
      async (args, state) => args.state === 'any' || args.state === state.state,
    );

    // Dashboard widget: let the user pick which controller it controls.
    this.homey.dashboards.getWidget('fan').registerSettingAutocompleteListener('device', async (query) => {
      const needle = String(query || '').toLowerCase();
      return this.homey.drivers.getDriver('xzense').getDevices()
        .filter((device) => device.getName().toLowerCase().includes(needle))
        .map((device) => ({ id: device.getData().id, name: device.getName() }));
    });

    this.log('Xzense app started');
  }
}

module.exports = XzenseApp;

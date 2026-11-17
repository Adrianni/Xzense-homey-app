'use strict';

const Homey = require('homey');
const { XzenseClient, XzenseError } = require('../../lib/client');

const PIN_PATTERN = /^[0-9A-F]{4}$/;
const DISCOVER_TIMEOUT_MS = 15000;

class XzenseDriver extends Homey.Driver {
  async onInit() {
    this.log('Xzense driver initialised');
  }

  async onPair(session) {
    let discovered = [];
    let selected = null;

    // Step 1: scan and show nearby Xzense controllers so the user picks the right one.
    session.setHandler('discover', async () => {
      selected = null;
      const advertisements = await this.homey.ble.discover([], DISCOVER_TIMEOUT_MS);
      discovered = advertisements.filter(
        (adv) => typeof adv.localName === 'string' && adv.localName.toLowerCase().startsWith('xzense'),
      );
      this.log(`Pairing scan found ${discovered.length} Xzense controller(s)`);
      return discovered
        .map((adv) => ({
          uuid: adv.uuid,
          name: adv.localName,
          rssi: typeof adv.rssi === 'number' ? adv.rssi : null,
          shortId: String(adv.uuid).slice(-4).toUpperCase(),
        }))
        .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
    });

    session.setHandler('select_device', async (uuid) => {
      const adv = discovered.find((a) => a.uuid === uuid);
      if (!adv) throw new Error(this.homey.__('pair.not_in_list'));
      selected = adv;
      return true;
    });

    session.setHandler('get_selected', async () => (selected ? selected.localName : null));

    // Step 2: the PIN is verified against the selected controller only, then the device is created.
    session.setHandler('set_pin', async (value) => {
      if (!selected) throw new Error(this.homey.__('pair.not_in_list'));
      const pin = String(value || '').trim().toUpperCase();
      if (!PIN_PATTERN.test(pin)) throw new Error(this.homey.__('pair.invalid_pin'));

      const client = new XzenseClient(this.homey, { address: selected.uuid, pin }, this.log.bind(this));
      try {
        await client.poll((step) => session.emit('progress', step));
      } catch (err) {
        this.error(`Pairing check failed for ${selected.localName}:`, err.message);
        if (err instanceof XzenseError && err.code === 'BAD_PIN') {
          throw new Error(this.homey.__('pair.bad_pin'));
        }
        throw new Error(this.homey.__('pair.no_contact'));
      }

      return {
        name: selected.localName,
        data: { id: selected.uuid },
        store: { pin },
      };
    });
  }
}

module.exports = XzenseDriver;

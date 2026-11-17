# Xzense for Homey (unofficial)

A [Homey](https://homey.app) app that reads and controls an **Xzense chimney fan controller** over
Bluetooth Low Energy, using the Homey Pro's built-in Bluetooth.

> **Unofficial.** This project is not made by, affiliated with or endorsed by the maker of Xzense.
> "Xzense" is used only to describe which product the app works with.

> **Safety.** The app can change the fan speed and start or stop boost on a controller that is
> attached to a fireplace. Use it at your own risk, never rely on it for safety functions, and keep
> the controller's own safety features and alarms in place. See the [license](LICENSE): the software
> is provided without warranty.

## What it does

- **Fan speed:** a slider for the set fan speed, and a live sensor for the actual fan speed.
- **Boost:** a two-choice picker (off / on).
- **Sensors:** state (Ready, Boosting, Operation, Burnout, Afterrun, ...), chimney, inside and outside
  temperature, air pressure, panel battery and signal strength (the last two are inferred values).
- **Chimney alarm:** `alarm_heat` turns on at a temperature you choose (default 220 °C).
- **Flow cards:** set fan speed, start/stop boost, "state is" condition, "state changed to" trigger.
- **Dashboard widget:** a big live fan-speed number with large - and + buttons.
- **Pairing:** shows the Xzense controllers nearby (with signal strength) so you pick the right one before
  you enter its PIN. The PIN is only sent to the controller you selected.

## Requirements

- Homey Pro (2023 or newer) with Bluetooth, Homey firmware 12.2 or newer. Homey Cloud has no Bluetooth access.
- The controller's 4-character PIN (digits 0-9 and letters A-F).
- The controller must be within Bluetooth range of the Homey (a signal better than about -75 dBm works well).

## Install

```sh
git clone https://github.com/Adrianni/Xzense-homey-app.git
cd Xzense-homey-app
npm install -g homey      # the Homey CLI
homey login
homey app install         # installs the app permanently on your Homey
```

For development use `homey app run --remote`. (Without `--remote` the app runs in Docker on your computer,
which has no Bluetooth.)

Then add a device: **Devices -> + -> Xzense (unofficial)**, select your controller, enter the PIN.

## Settings (per device)

| Setting | Default | Meaning |
|---|---|---|
| Poll interval | 60 s | How often the controller is read while idle |
| Poll interval while burning | 30 s | How often it is read during boost, operation, burnout, afterrun |
| Fan slider step | 5 % | Step of the slider and of the widget buttons |
| Minimum / maximum fan speed | 10 % / 100 % | Safety limits; commands outside them are clamped |
| Chimney alarm temperature | 220 °C | Threshold for the `alarm_heat` alarm |

Changes you make from Homey (slider, boost, flow cards, widget) are **sent immediately** and never wait
for the poll interval. The slider writes the first change at once, and if you keep dragging, the newest value
is written over the same Bluetooth connection. After a change the app reads the controller repeatedly until the
fan (or boost) has reached the new value, then the regular poll interval starts over.

## Good to know

- The controller accepts **one Bluetooth client at a time**. If another app (for example the vendor's phone
  app) is connected, the Homey cannot connect, and the other way around.
- The app connects briefly on each poll instead of staying connected, which spares the controller's battery.
- A wrong PIN is tried once and the app then stops polling, because the controller may lock out repeated
  failures. Remove and re-add the device with the right PIN.
- Tested with a single controller only. Registers marked "inferred" in `lib/protocol.js` are best guesses,
  and other controller software versions may behave differently.
- Homey's own UI limits what the device screen can show: a slider has no label, and buttons and sensors live on
  separate tabs. The dashboard widget exists to give a clearer view of the fan speed.

## Development

```sh
npm test                                   # protocol and command-sequence tests
homey app validate --level publish
```

`lib/protocol.js` is an independent implementation written from the wire format (frame layout, CRC,
message ids, field layouts). The tests check it against recorded reference frames and against replies captured
from a real controller. Thanks to the community project
[larsmarius87/xzense-home-assistant](https://github.com/larsmarius87/xzense-home-assistant), whose published
protocol notes made this possible. No code from that project is included here.

Layout: `lib/` (protocol and Bluetooth session), `drivers/xzense/` (pairing, device), `widgets/fan/`
(dashboard widget), `.homeycompose/` (capabilities and flow cards), `locales/` (English and Norwegian).

## License

[MIT](LICENSE)

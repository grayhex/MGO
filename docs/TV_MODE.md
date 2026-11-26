# TV Mode

Open **TV Mode** from the sidebar or go directly to `/tv`. The browser remembers the mode. Use **Menu → Exit TV Mode** to return to the desktop interface. In a running game the menu also offers **Resume**, display and sound settings, and a confirmed stop. Save in the game before stopping. Games and saves still live on your MGO server.

## Raspberry Pi and 4K TV

Use a Raspberry Pi 4/5 or a similar Linux client with Chromium. The MGO server and its emulators can stay on your NAS. Complete initial MGO setup on a desktop, then open the server's LAN HTTPS address on the Pi. Trust the server certificate on the Pi and on any phone used as a remote. See [HTTPS setup](HTTPS.md) and [Docker and NAS setup](DOCKER.md).

Set the TV input to its native 3840×2160 at 60 Hz in the Raspberry Pi display settings. Use a 4K60-capable HDMI cable and the port that supports that mode on your board. Turn off overscan on the TV for the full safe area. The same interface works at 1920×1080 and with Chromium display scaling.

Use the browser's **Toggle fullscreen** menu action with a physical browser gesture, or start the kiosk at the LAN URL from your desktop autostart:

```sh
chromium --kiosk https://mgo.local:8443/tv
```

Some Linux images package the browser as `chromium-browser`. If sound requires a browser gesture on a dedicated kiosk controlled exclusively by a gamepad or network remote, start it with Chromium's `--autoplay-policy=no-user-gesture-required` flag. Kiosk fullscreen is managed by Chromium. Closing the MGO TV interface returns to the library inside the kiosk browser.

## Controls

| Source | Navigate | Confirm | Back | Global menu |
|---|---|---|---|---|
| Standard gamepad | D-pad / left stick | South face button | Select / View | Start / Menu |
| Keyboard | Arrow keys | Enter | Backspace in the UI | M |
| Sony Ericsson HID | Navigation buttons, or 2/4/6/8 in the UI | OK, or 5 in the UI | Volume down, right soft key in the UI, or `*` in the UI | Volume up, or hold `#` in a game |
| Network phone | D-pad | OK | Back | Menu |

Open **Controller mapping** from the global menu to change gamepad actions and the dedicated menu/back buttons. Global and per-game mappings are shared with the standard player. Keyboard and other keyboard HID bindings use the standard player's keyboard mapping. A quick `#` press on the Sony Ericsson profile still goes to the game. Install the updated `.hid` file for the volume buttons. Delivery of extended keys, held keys and simultaneous inputs depends on the handset firmware and host OS. [Download and test the Sony Ericsson profiles](PLAYER_CONTROLS.md#sony-ericsson-bluetooth-controllers)

The library groups installed versions under a single card. Use **Recently played**, **Favorites**, platform filters or **Search games**. Search has an on-screen keyboard with Latin and Cyrillic layouts. The game card contains build and handset choices, available screenshots, and compatibility settings for Java ME. For native games the selector lists compatible firmware and marks what needs to be installed.

By default gameplay fills the display area with a clean LCD view. Use **Display** to switch between **Lights Out**, **Screen** and **Phone**. Whole-number scaling uses physical display pixels in Lights Out. At 4K a 240×320 image can scale to 1440×1920. Turn whole-number scaling off to fit the available area while keeping the aspect ratio. Nearest-neighbor keeps the pixel edges sharp. The emulator still renders at its normal resolution.

## Pair a phone

1. Connect the phone to the same LAN as the TV browser. Open **Menu → Pair a phone**. A fresh TV profile opens this screen automatically.
2. Scan the QR code, or open the displayed LAN address on the phone and enter the eight-digit code. Use **Set LAN address** if the TV opened MGO on localhost or through a name the phone cannot resolve.
3. Approve the request with an existing controller on the TV, or type the second code displayed only on the TV into the phone. The second option works with no local input device.
4. The phone changes between navigation and the full gameplay keypad when the TV changes modes. The phone's keyboard can also enter a library search. **Menu** remains available in gameplay.

Once approved, the phone controls its paired TV browser over the same HTTPS gateway. A dropped phone connection releases its held buttons. Reopening the paired tab while the TV remains connected restores the controller without replaying presses. Use **Unpair phone** to revoke access. Closing or reloading the TV page ends the pairing. Codes expire after two minutes and attempts are limited.

## Screenshots and verification

[4K library](img/tv/library.webp) · [4K game card](img/tv/card.webp) · [4K gameplay](img/tv/game.webp) · [4K game menu](img/tv/menu.webp) · [Mobile remote](img/tv/remote.webp)

Browser tests exercise real KEmulator games with a simulated gamepad, simulated Sony Ericsson HID keys and a separate mobile browser context. They cover the 3840×2160 and 1920×1080 layouts, controller navigation, pairing, search, multitouch and releasing keys on reconnect. The tests also check certificate rejection and pairing isolation. Physical Raspberry Pi, 4K TV and Sony Ericsson input were unavailable for this run.

To recreate the screenshots, build MGO and its test fixtures, then run `MGO_TV_SCREENSHOTS=/tmp/mgo-tv node tests/e2e/tv-mode.mjs`.

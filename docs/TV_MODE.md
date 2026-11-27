# TV Mode

Open **TV Mode** from the sidebar or go directly to `/tv`. **Home** shows recently played and added games, collections and phone previews. Move across the top row to change the featured game. Play it from Home or open its card for builds, compatible handsets and screenshots. **Library**, **Collections**, **Phones** and **Settings** are available from the top navigation. TV Mode uses the same light or dark palette as the desktop interface.

The browser remembers TV Mode. Use **Settings → Exit TV Mode** to return to the desktop interface. During gameplay, open the menu to resume, adjust display and sound, or stop the game. **Resume** continues the same session when you bring a paused game over from the desktop player. Save in the game before stopping. Games and saves stay on your MGO server.

## Raspberry Pi and 4K TV

Use a Raspberry Pi 4/5 or a similar client with Chromium. The MGO server and its emulators can stay on your NAS. Complete initial MGO setup on a desktop, then open the server's LAN HTTPS address on the client connected to the TV. Trust the server certificate on that client. See [HTTPS setup](HTTPS.md) and [Docker and NAS setup](DOCKER.md).

Set the TV input to its native 3840×2160 at 60 Hz in the Raspberry Pi display settings. Use a 4K60-capable HDMI cable and the port that supports that mode on your board. Turn off overscan on the TV for the full safe area. The same interface works at 1920×1080 and with Chromium display scaling.

Use the browser's **Toggle fullscreen** menu action with a physical browser gesture, or start the kiosk at the LAN URL from your desktop autostart:

```sh
chromium --kiosk https://mgo.local:8443/tv
```

Some Linux images package the browser as `chromium-browser`. If sound requires a browser gesture on a dedicated kiosk controlled with a gamepad, start it with Chromium's `--autoplay-policy=no-user-gesture-required` flag. Kiosk fullscreen is managed by Chromium. Closing the MGO TV interface returns to the library inside the kiosk browser.

## Controls

| Source | Navigate | Confirm | Back | Global menu |
|---|---|---|---|---|
| Standard gamepad | D-pad / left stick | South face button | East face button in the UI or Select / View | Start / Menu |
| Keyboard | Arrow keys | Enter | Backspace in the UI | M |

Open **Controller mapping** from the global menu to change gamepad actions and the dedicated menu/back buttons. Global and per-game mappings are shared with the standard player. Connect a Sony Ericsson phone to the computer running the TV browser to use its HID buttons during gameplay. Use the gamepad or keyboard for the library and menus. [Download and test the Sony Ericsson profiles](PLAYER_CONTROLS.md#sony-ericsson-bluetooth-controllers)

The library groups installed versions under a single card. Use **Recently played**, **Favorites**, platform filters or **Search games**. Search and game text entry use an on-screen keyboard with Latin and Cyrillic layouts and an **Uppercase** toggle. The game card contains build and handset choices, available screenshots, and compatibility settings for Java ME. For native games the selector lists compatible firmware and marks what needs to be installed.

**Lights Out** is the default. It uses the same dimmed handset artwork as the desktop player and keeps the LCD at full brightness. Choose **Screen** for the lit close-up, **Phone** for the full handset or **Game only** for the bare canvas. At 4K a 240×320 image in **Game only** can scale to 1440×1920. Turn whole-number scaling off to fit the available area while keeping the aspect ratio. Nearest-neighbor keeps the pixel edges sharp. The emulator still renders at its normal resolution.

## Screenshots and verification

[Home in dark theme](img/tv/home.webp) · [Home in light theme](img/tv/home-light.webp) · [4K library](img/tv/library.webp) · [4K game card](img/tv/card.webp) · [4K Lights Out](img/tv/game.webp) · [4K game menu](img/tv/menu.webp)

Browser tests exercise real KEmulator games with a simulated gamepad and simulated Sony Ericsson HID keys. They cover the 3840×2160 and 1920×1080 layouts, dashboard shelves, collection filters, phone previews, display modes and HID game input.

To recreate the screenshots, build MGO and its test fixtures, then run `MGO_TV_SCREENSHOTS=/tmp/mgo-tv node tests/e2e/tv-mode.mjs`.

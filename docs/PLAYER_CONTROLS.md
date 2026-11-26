# Phone controls, Bluetooth and gamepads

## Automatic phone profiles

`packages/protocol/src/phones.ts` is the explicit shared mapping. The API resolves IDs against `res/presets.xml` in the installed KEmulator jar; no synthetic device entries or platform identities are added.

| Phone | Actual preset ID | Match | Resolution | Layout | FORCE_FULLSCREEN | Platform |
|---|---|---|---|---|---|---|
| Nokia 6100 | 128x128-common-full-screen | generic | 128×128 | Nokia | false | unchanged emulator default |
| Nokia 6230i | 208x208-nokia-full-screen | exact, comment names 6230i | 208×208 | Nokia | false | Nokia6230i |
| Nokia N95-1 | 240x320-common-full-screen | generic | 240×320 | Nokia | false | unchanged emulator default |
| Nokia E71 | 320x240-common-full-screen | generic | 320×240 | Nokia | false | unchanged emulator default |
| Sony Ericsson K750i | 176x220-common-full-screen | generic | 176×220 | Nokia-compatible codes | false | unchanged emulator default |
| Sony Ericsson W995 | 240x320-common-full-screen | generic | 240×320 | Nokia-compatible codes | false | unchanged emulator default |
| Sony Ericsson K790i | 240x320-common-full-screen | generic | 240×320 | Nokia-compatible codes | false | unchanged emulator default |
| Motorola RAZR V3 | 176x220-common-full-screen | generic | 176×220 | Nokia-compatible codes | false | unchanged emulator default |
| Nokia 5800 XpressMusic | 360x640-common-full-screen | generic | 360×640 | Nokia-compatible codes + pointer | false | unchanged emulator default |
| Samsung S5230 Star | 240x400-common-full-screen | generic | 240×400 | Nokia-compatible codes + pointer | false | unchanged emulator default |
| Siemens S65 | 132x176-siemens-full-screen | Siemens CX75 fallback | 132×176 | Siemens | false | unchanged emulator default |

The table describes the pinned build's 59 presets, not full hardware emulation. A generic profile does not impersonate a Nokia N95, E71 or Sony Ericsson platform. Properties and fullscreen policy follow the selected *existing* preset via midlets.ini; no manufacturer API support is inferred from a skin.

Automatic mode applies skinId → device + width/height + layout on the server, including saved settings on subsequent starts. `skinId` and `profileMode` are saved in the game's SQLite settings. Advanced mode preserves independent skin, preset and explicit resolution/layout overrides. Existing callers without profileMode keep the prior API behavior. UI changes are saved immediately after automatic profile fields are synchronized. Running session status returns its actual layout/device/heap; changing pending settings never changes its key codes. The restart prompt compares device, layout, resolution and heap, not just dimensions. Screen/Zoom remains presentation only.

## Lights Out

Screen view shows the original handset controls alongside the display. On N-Gage Classic and QD the directional controls sit above the numeric keypad in the left column.

Use **Controls → On-screen keypad** to show or hide the detached keypad in Screen view. Pick 100%, 150% or 200% under **Keypad width**. The size applies to Lights Out too. Phone view already has interactive keys on the handset. The player remembers these choices in the browser.

Use the moon button or **Alt+L** to toggle Lights Out. **Escape** exits. The player hides the side panels and dims the handset and onscreen controls. The LCD stays at full brightness. Moving or touching the pointer reveals the menu for the touch controls, fullscreen and exit. The presentation preference is saved in the browser and respects reduced motion.

## Sony Ericsson Bluetooth controllers

1. Pair the phone with the computer running the browser in your operating system's Bluetooth settings.
2. In **Settings → Sound & controls → Bluetooth phone**, click **K790i**, **K750i** or **W995** to download its `.hid` file directly from MGO. Use the computer's Bluetooth file transfer or USB to send it to the phone. Follow any installation prompt on the phone.
3. On the phone, open **Entertainment → Remote Control**, select the `MGO-` profile for your model and choose the paired computer. Click **Test phone buttons** in MGO and press a key on the phone. Then open a game and use the navigation keys, soft keys, digits, `*` and `#`. Slide the W995 open to use its number pad.

In TV Mode, volume up opens the global menu and volume down goes back. Holding `#` opens the menu on phones that deliver a held key. [TV Mode controls](TV_MODE.md#controls)

**Controls** shows the most recently used input source with a phone, gamepad or keyboard icon. The phone icon appears after MGO receives a key from a profile. The operating system handles pairing and file transfer. All three profiles send standard USB HID keyboard usages F13–F24, some with Shift. Keyboard events carry no phone model. Use the tester to check that your browser receives those codes. The player applies the logical keys to the running emulator's layout. Existing custom keyboard bindings for those codes take precedence.

The browser forwards each press and release through the same stream as normal keyboard input. The MGO server can be on another machine. The Sony Ericsson remote exposes keyboard and mouse HID with no vibration output. Existing vibration on supported gamepads and the device running the browser remains available. [Sony Ericsson HID developer guidelines](https://www.yumpu.com/en/document/view/7032510/bluetoothtm-hid-remote-control-sony) · [WebHID protected usages](https://developer.chrome.com/docs/capabilities/hid#security_and_privacy)

The profiles are built from `apps/web/src/phoneRemote.ts` and the included handset display images. Regenerate them after changing the mapping with `node --experimental-strip-types tools/controls/build-sony-ericsson-profiles.mjs` (Node 22+ and GNU tar).

## Gamepads

GamepadPoller reuses InputController's per-source/reference-counted input. It polls all browser-visible connected devices; Xbox/PlayStation use the browser's standard mapping where supplied. HID indices and operating-system layouts vary; arbitrary buttons and signed axes can be rebound. A browser may require a user gesture, HTTPS/localhost or pressing a controller button before exposing it. The app does not pair Bluetooth devices itself.

Open **Gamepad settings / UI navigation** or press default Start (button 9). Input is released while configuring. Select an action, press a button or move a stick; adjust deadzone and Save mapping globally or for the game. Per-game overrides take precedence; Use global removes the override. Fn/physical handset functions not implemented by the existing logical input system remain unmapped.

Default standard controls: D-pad/left stick directions, face bottom = Fire, face left/right = soft keys, face top = 5, shoulders = */#. Start enters/exits player UI navigation; Back exits menus/Lights Out. In navigation mode directions move focus, Fire activates; left/right on selects change the value. Every Java ME digit/action plus UI lights/fullscreen/menu/back can be explicitly bound. Connected IDs and held actions are shown, and shared keypad/PhoneSkin feedback uses InputController.

Focus loss/hidden page, disconnect and remapping release only relevant sources. Unfocused/disabled held inputs are blocked until neutral before rearming. Multiple controllers, keyboard, skin and touches can hold the same action without releasing one another.

**Controls → Gamepad vibration** sends Java ME vibration requests to a connected controller that exposes rumble in the browser. The toggle is saved in the browser. Rumble stops on pause, exit or focus loss.

## Validation

- `npm run build`, `npm test`
- `npm run test:integration` (real KEmulator; phones.test.ts covers every handset mapping, frame size, Fire, platform, fullscreen policy and session persistence).
- `node tests/e2e/phone-expansion.mjs`: five added handsets, body keys, real pointer coordinates, full/zoom views and session persistence; included in `npm run test:e2e`.
- `CHROMIUM_PATH=/usr/bin/chromium node tests/e2e/player-features.mjs` for system Chromium; omit the variable to use Playwright's installed browser.

Browser tests use the real backend/MIDlet, simulated Gamepad API data and simulated Sony Ericsson key events. Actual Bluetooth pairing and OS key delivery need a physical test. Device disconnect, focus, deadzone and multiple-source input also have deterministic unit tests.

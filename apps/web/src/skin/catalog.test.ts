import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { PHONE_PROFILES } from '@mgo/protocol';
import { bindingFor, SKIN_IDS } from './registry';
import { keypadCrops, parseHitboxSvg } from './hitboxes';

it('all selectable skins have server profiles and actual runtime assets', () => {
  assert.deepEqual([...SKIN_IDS].sort(), Object.keys(PHONE_PROFILES).sort());
  for (const id of SKIN_IDS) {
    const base = new URL(`../../public/phones/${id}/`, import.meta.url);
    const c = JSON.parse(readFileSync(new URL('config.json', base), 'utf8'));
    assert.equal(c.id, id);
    for (const filename of [c.assets.body, c.assets.hitboxes, c.assets.preview, c.views.screen.body]) {
      assert.ok(readFileSync(new URL(filename, base)).length > 0, `${id}: ${filename}`);
    }
  }
});

it('the Siemens S65 binds the five-way joystick, soft keys and twelve numeric keys', () => {
  const base = new URL('../../public/phones/siemens-s65/', import.meta.url);
  const c = JSON.parse(readFileSync(new URL('config.json', base), 'utf8'));
  const hitboxes = parseHitboxSvg(readFileSync(new URL(c.assets.hitboxes, base), 'utf8'))
    .map(box => ({ ...box, action: bindingFor(c, box.id) }));
  const actions = hitboxes.map(box => box.action).filter(Boolean).sort();
  assert.deepEqual(actions, ['up', 'down', 'left', 'right', 'fire', 'softLeft', 'softRight', 'star', 'pound',
    ...Array.from({ length: 10 }, (_, digit) => `d${digit}`)].sort());
  for (const key of ['call', 'end', 'shortcut']) assert.equal(c.keyMappings[key], null);
  assert.equal(keypadCrops({ config: c, hitboxes, base: '', warnings: [] })[0]?.y, c.keypadCropTop);
  const zoomCrop = c.views.screen.cropInFull;
  assert.equal(zoomCrop.y + zoomCrop.height, c.keypadCropTop, 'the split line keeps the S65 mark with the keypad');
});

it('touchscreen phones preserve their physical controls and use an external game keypad', () => {
  for (const id of ['nokia-5800', 'samsung-s5230', 'nokia-n8']) {
    const c = JSON.parse(readFileSync(new URL(`../../public/phones/${id}/config.json`, import.meta.url), 'utf8'));
    assert.deepEqual(c.input, { kind: 'touchscreen', pointer: true, externalKeypad: true });
    assert.ok(!c.buttons.some((b: { id: string }) => /^(d\d|up|down|left|right|fire)$/.test(b.id)));
    assert.deepEqual(c.views.screen.buttons, []);
  }
});

it('Nokia E71 uses the printed numeric layer for clickable digits, star and pound', () => {
  const base = new URL('../../public/phones/nokia-e71/', import.meta.url);
  const config = JSON.parse(readFileSync(new URL('config.json', base), 'utf8'));
  assert.equal(config.keyMappings['key-U'], 'star');
  assert.equal(config.keyMappings['key-J'], 'pound');
  for (const [digit, key] of Array.from('MRTYFGHVBN').entries()) {
    assert.equal(config.keyMappings[`key-${key}`], `d${digit}`);
    assert.equal(config.buttons.find((b: { id: string }) => b.id === `key-${key}`).label, `${key} / ${digit}`);
  }
  assert.ok(readFileSync(new URL(config.views.full.legends, base)).length > 0);
});

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHONE_REMOTE_PROFILES, SONY_ERICSSON_KEYS, SONY_PHONE_INDICATOR } from '../../apps/web/src/phoneRemote.ts';

const binding = (key, usage, modifiers = '00') => [
  `    <${key}>`,
  '      <ACTION>',
  `        <KEYBOARD MODIFIERS = "${modifiers}" USAGEID = "${usage.toString(16).toUpperCase().padStart(2, '0')}"/>`,
  '      </ACTION>',
  `    </${key}>`,
].join('\r\n');
const bindings = Object.entries(SONY_ERICSSON_KEYS).map(([key, [, usage]]) => binding(key, usage));
bindings.push(binding(SONY_PHONE_INDICATOR.key, SONY_PHONE_INDICATOR.usage, SONY_PHONE_INDICATOR.modifiers));
const config = [
  '<SONY_ERICSSON_REMOTE_CONTROL_CONFIGURATION VERSION="1.0">',
  '  <KEYMAP>', ...bindings, '  </KEYMAP>', '</SONY_ERICSSON_REMOTE_CONTROL_CONFIGURATION>', '',
].join('\r\n');
const scratch = mkdtempSync(join(tmpdir(), 'mgo-hid-'));
try {
  for (const { model, name, url } of PHONE_REMOTE_PROFILES) {
    const output = fileURLToPath(new URL(`../../apps/web/public${url}`, import.meta.url));
    writeFileSync(join(scratch, `${name}.kcf`), config, { mode: 0o644 });
    copyFileSync(new URL(`./${model.toLowerCase()}-screen.jpg`, import.meta.url), join(scratch, `${name}.jpg`));
    execFileSync('tar', ['--format=ustar', '--mtime=@0', '--owner=0', '--group=0', '--mode=644', '-cf', output, '-C', scratch, `${name}.kcf`, `${name}.jpg`]);
    chmodSync(output, 0o644);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

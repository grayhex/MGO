import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHONE_REMOTE_PROFILES, SONY_ERICSSON_KEYS, SONY_TV_KEYS } from '../../apps/web/src/phoneRemote.ts';

const bindings = Object.entries({ ...SONY_ERICSSON_KEYS, ...SONY_TV_KEYS }).map(([key, [, usage, shifted]]) => (
  `    <${key}><ACTION><KEYBOARD MODIFIERS="${shifted ? '02' : '00'}" USAGEID="${usage.toString(16).toUpperCase()}" /></ACTION></${key}>`
));
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
    execFileSync('tar', ['--format=ustar', '--mtime=@0', '--owner=0', '--group=0', '--mode=644', '-cf', output, '-C', scratch, `${name}.jpg`, `${name}.kcf`]);
    chmodSync(output, 0o644);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

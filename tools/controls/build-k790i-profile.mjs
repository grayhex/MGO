import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { K790I_KEYS, K790I_PROFILE_FILE } from '../../apps/web/src/phoneRemote.ts';

const name = 'MGO-K790i';
const output = fileURLToPath(new URL(`../../apps/web/public${K790I_PROFILE_FILE}`, import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'mgo-hid-'));
try {
  const bindings = Object.entries(K790I_KEYS).map(([key, [, usage, shifted]]) => (
    `    <${key}><ACTION><KEYBOARD MODIFIERS="${shifted ? '02' : '00'}" USAGEID="${usage.toString(16).toUpperCase()}" /></ACTION></${key}>`
  ));
  const config = [
    '<SONY_ERICSSON_REMOTE_CONTROL_CONFIGURATION VERSION="1.0">',
    '  <KEYMAP>', ...bindings, '  </KEYMAP>', '</SONY_ERICSSON_REMOTE_CONTROL_CONFIGURATION>', '',
  ].join('\r\n');
  writeFileSync(join(scratch, `${name}.kcf`), config, { mode: 0o644 });
  copyFileSync(new URL('./k790i-screen.jpg', import.meta.url), join(scratch, `${name}.jpg`));
  execFileSync('tar', ['--format=ustar', '--mtime=@0', '--owner=0', '--group=0', '--mode=644', '-cf', output, '-C', scratch, `${name}.jpg`, `${name}.kcf`]);
  chmodSync(output, 0o644);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

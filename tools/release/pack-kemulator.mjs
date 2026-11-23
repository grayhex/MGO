import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';

const [runtime, out] = process.argv.slice(2);
if (!runtime || !out) throw new Error('Usage: pack-kemulator.mjs <built KEmulator directory> <release directory>');
const version = readFileSync(path.join(runtime, 'KEM_VERSION'), 'utf8').trim();
if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('Invalid KEmulator version');
const names = ['KEM_VERSION', 'KEM_COMMIT', 'KEmulator.jar', 'sensorsimulator.jar', 'swt-gtk-linux-x86_64.jar', 'lwjgl-natives-linux.jar', 'lwjgl-opengl-natives-linux.jar', 'lwjgl-glfw-natives-linux.jar', 'lwjgl3-swt-linux.jar', 'libjinput-linux64.so'];
for (const file of readdirSync(path.join(runtime, 'lang'))) {
  if (/^[a-zA-Z0-9_-]+\.txt$/.test(file)) names.push(`lang/${file}`);
}
const bytes = zipSync(Object.fromEntries(names.map(name => [name, readFileSync(path.join(runtime, name))])), { level: 0 });
mkdirSync(out, { recursive: true });
const bundle = path.join(out, `mgo-kemulator-v${version}-bridge1-linux-amd64.zip`);
writeFileSync(bundle, bytes);
console.log(bundle);

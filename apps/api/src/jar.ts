import { unzipSync } from 'fflate';
import { readConstantPool } from './analysis/classfile.js';

export class UploadError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface JarInfo {
  name: string;
  vendor: string;
  version: string;
  midlets: { name: string; className: string; icon: string | null }[];
  classVersion: number;
  icon: { bytes: Uint8Array; path: string } | null;
  warnings: string[];
  attributes: Record<string, string>;
  missingMidlet?: string;
  repairedMidlet?: string;
  fileHasClass: (name: string) => boolean;
}

const MAX_ENTRIES = 20_000;
const MAX_UNCOMPRESSED = 512 * 1024 * 1024;
const MAX_MANIFEST = 256 * 1024;
const MAX_ICON = 2 * 1024 * 1024;

/** Parses "Key: value" manifests/JADs including 72-column continuation lines. */
export function parseAttributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const logical: string[] = [];
  for (const l of lines) {
    if (l.startsWith(' ') && logical.length) logical[logical.length - 1] += l.slice(1);
    else logical.push(l);
  }
  for (const l of logical) {
    const i = l.indexOf(':');
    if (i <= 0) continue;
    const k = l.slice(0, i).trim();
    if (k && !(k in out)) out[k] = l.slice(i + 1).trim();
  }
  return out;
}

function safeEntryName(n: string): boolean {
  if (n.includes('\0') || n.startsWith('/') || n.includes('\\')) return false;
  return !n.split('/').some((seg) => seg === '..');
}

const decoder = new TextDecoder('utf-8', { fatal: false });

export function parseJad(buf: Uint8Array): Record<string, string> {
  if (buf.length > MAX_MANIFEST) throw new UploadError('jad_too_large', 'JAD file is too large');
  return parseAttributes(decoder.decode(buf));
}

const MIDLET = 'javax/microedition/midlet/MIDlet';
const classPath = (name: string) => name.replace(/\./g, '/');
const validClassName = /^[A-Za-z0-9_.$/]{1,200}$/;

function entrypoint(descriptor: string | undefined): JarInfo['midlets'][number] | null {
  const parts = descriptor?.split(',').map(value => value.trim());
  return parts?.[2] ? { name: parts[0] ?? '', icon: parts[1] || null, className: parts[2].replaceAll('/', '.') } : null;
}

function discoverMidlet(jar: Uint8Array): string | undefined {
  try {
    let classBytes = 0;
    const files = unzipSync(jar, {
      filter: (entry) => {
        if (!entry.name.endsWith('.class')) return false;
        classBytes += entry.originalSize;
        if (classBytes > 16 * 1024 * 1024) throw new Error('MIDlet discovery size limit');
        return true;
      },
    });
    const classes = new Map<string, ReturnType<typeof readConstantPool>>();
    for (const [file, bytes] of Object.entries(files)) {
      const cls = readConstantPool(bytes);
      if (cls.name && cls.superName && file === cls.name + '.class') classes.set(cls.name, cls);
    }
    const candidates: string[] = [];
    for (const [name, cls] of classes) {
      if (cls.abstract || !validClassName.test(name) || name === MIDLET) continue;
      const seen = new Set<string>();
      let parent = cls.superName;
      while (parent && parent !== MIDLET && !seen.has(parent)) {
        seen.add(parent);
        parent = classes.get(parent)?.superName;
      }
      if (parent === MIDLET) {
        candidates.push(name.replaceAll('/', '.'));
        if (candidates.length > 1) return undefined;
      }
    }
    return candidates[0];
  } catch {
    // Incomplete or unreadable bytecode is insufficient evidence for a replacement.
    return undefined;
  }
}

export function repairedJad(info: JarInfo): string {
  const attributes = Object.entries(info.attributes).filter(([name]) => !/^MIDlet-\d+$/.test(name));
  const midlet = info.midlets[0]!;
  attributes.push(['MIDlet-1', [midlet.name, midlet.icon ?? '', midlet.className].join(', ')]);
  return attributes.map(([name, value]) => `${name}: ${value.replaceAll('\\', '\\\\')}`).join('\n') + '\n';
}

export function parseJar(buf: Uint8Array, jad?: Record<string, string>): JarInfo {
  if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new UploadError('not_a_jar', 'File is not a JAR/ZIP archive');

  // Pass 1: look at the central directory only (filter returns false -> nothing is inflated).
  let entries = 0;
  let total = 0;
  const names: string[] = [];
  try {
    unzipSync(buf, {
      filter: (f) => {
        entries++;
        total += f.originalSize;
        if (entries > MAX_ENTRIES) throw new UploadError('too_many_entries', 'JAR has too many entries');
        if (total > MAX_UNCOMPRESSED) throw new UploadError('zip_bomb', 'JAR expands to an unreasonable size');
        if (!safeEntryName(f.name)) throw new UploadError('unsafe_entry', `JAR contains an unsafe entry name: ${JSON.stringify(f.name)}`);
        names.push(f.name);
        return false;
      },
    });
  } catch (e) {
    if (e instanceof UploadError) throw e;
    throw new UploadError('corrupt_zip', 'JAR archive is corrupt or unreadable');
  }

  const nameSet = new Set(names);
  const fileHasClass = (name: string) => nameSet.has(classPath(name) + '.class');
  const manifestName = names.find((n) => n.toUpperCase() === 'META-INF/MANIFEST.MF');
  if (!manifestName) throw new UploadError('no_manifest', 'JAR has no META-INF/MANIFEST.MF');

  // Pass 2: inflate manifest only to learn MIDlet entries.
  const read = (wanted: string[], maxSize: number): Record<string, Uint8Array> => {
    const want = new Set(wanted);
    return unzipSync(buf, {
      filter: (f) => {
        if (!want.has(f.name)) return false;
        if (f.originalSize > maxSize) throw new UploadError('entry_too_large', `Entry ${f.name} is too large`);
        return true;
      },
    });
  };
  const m = read([manifestName], MAX_MANIFEST)[manifestName];
  if (!m) throw new UploadError('no_manifest', 'Cannot read MANIFEST.MF');
  const manifest = parseAttributes(decoder.decode(m));
  const attrs = { ...manifest, ...(jad ?? {}) };

  const midlets: JarInfo['midlets'] = [];
  for (let i = 1; i < 50; i++) {
    if (!attrs[`MIDlet-${i}`]) break;
    const midlet = entrypoint(attrs[`MIDlet-${i}`]);
    if (midlet) midlets.push(midlet);
  }
  const warnings: string[] = [];
  if (!midlets.length) warnings.push('No MIDlet-n entry found; the emulator may not be able to pick a MIDlet class.');
  let missingMidlet: string | undefined;
  let repairedMidlet: string | undefined;
  const declared = midlets[0];
  if (declared && !fileHasClass(declared.className)) {
    const original = entrypoint(manifest['MIDlet-1']);
    const replacement = original && fileHasClass(original.className) ? original.className : discoverMidlet(buf);
    if (replacement) {
      repairedMidlet = declared.className;
      midlets.splice(0, midlets.length, { ...declared, className: replacement });
      warnings.push(`The declared MIDlet class "${repairedMidlet}" is missing. MGO will launch "${replacement}".`);
    } else {
      missingMidlet = declared.className;
      warnings.push(`The declared MIDlet class "${missingMidlet}" is missing and no unique replacement was found.`);
    }
  }

  // Class file version of the first MIDlet (KEmulator refuses >= 49).
  let classVersion = 0;
  const first = midlets[0];
  const classEntry = first ? `${classPath(first.className)}.class` : names.find((n) => n.endsWith('.class'));
  if (classEntry && nameSet.has(classEntry)) {
    const c = read([classEntry], 8 * 1024 * 1024)[classEntry];
    if (c && c.length > 8 && c[0] === 0xca && c[1] === 0xfe && c[2] === 0xba && c[3] === 0xbe) classVersion = (c[6]! << 8) | c[7]!;
  }
  if (classVersion >= 49)
    warnings.push(`Class files are version ${classVersion} (Java 5+). KEmulator only accepts J2ME-era classes (<= 48), so this JAR will not start.`);
  if (!classVersion) warnings.push('Could not read the class file version of the MIDlet class.');

  // Icon
  let icon: JarInfo['icon'] = null;
  const iconPathRaw = attrs['MIDlet-Icon'] ?? first?.icon ?? null;
  if (iconPathRaw) {
    const p = iconPathRaw.replace(/^\/+/, '');
    if (nameSet.has(p) && safeEntryName(p)) {
      try {
        const b = read([p], MAX_ICON)[p];
        if (b && b[0] === 0x89 && b[1] === 0x50) icon = { bytes: b, path: p };
      } catch {
        /* optional */
      }
    }
  }

  return {
    name: attrs['MIDlet-Name'] ?? first?.name ?? 'Unnamed MIDlet',
    vendor: attrs['MIDlet-Vendor'] ?? 'Unknown',
    version: attrs['MIDlet-Version'] ?? '',
    midlets,
    classVersion,
    icon,
    warnings,
    attributes: attrs,
    fileHasClass,
    ...(missingMidlet ? { missingMidlet } : {}),
    ...(repairedMidlet ? { repairedMidlet } : {}),
  };
}

export function sanitizeText(s: string, max = 120): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

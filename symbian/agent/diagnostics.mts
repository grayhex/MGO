import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { audioEnvironment } from './audio.mts';
const run = promisify(execFile);
interface AudioStatus {
  ready: boolean;
  backend: string;
  version: string | null;
  sink: string | null;
  error: string | null;
}
export interface AudioCapture { streams: number; bytes: number; lastError: string | null }
let checked = 0;
let cached: AudioStatus | null = null;
export async function audioDiagnostics(env: NodeJS.ProcessEnv, capture: AudioCapture) {
  if (Date.now() - checked > 5000 || !cached) {
    checked = Date.now();
    if (env.AUDIO_CMD) cached = { ready: true, backend: 'custom capture', version: null, sink: null, error: null };
    else try {
      const { stdout } = await run('pactl', ['info'], { env: audioEnvironment(env), timeout: 1500, maxBuffer: 16384 });
      const field = (name: string) => new RegExp(`^${name}: (.+)$`, 'm').exec(stdout)?.[1] ?? null;
      const sink = field('Default Sink');
      cached = { ready: sink === audioEnvironment(env).PULSE_SINK, backend: 'PulseAudio', version: field('Server Version'), sink, error: sink === audioEnvironment(env).PULSE_SINK ? null : 'The default sink does not match the MGO capture sink' };
    } catch (e) { cached = { ready: false, backend: 'PulseAudio', version: null, sink: null, error: String(e instanceof Error ? ('stderr' in e && e.stderr || e.message) : e).trim().slice(0, 300) }; }
  }
  return { ...cached, ...capture };
}

let lastSample: { cpu: number; time: number } | null = null;
export function runtimeMetrics(read: (file: string) => string) {
  try {
    const cpu = Number(/^usage_usec (\d+)/m.exec(read('/sys/fs/cgroup/cpu.stat'))?.[1]);
    const [quota, period] = read('/sys/fs/cgroup/cpu.max').trim().split(/\s+/);
    const cores = quota === 'max' ? null : Number(quota) / Number(period);
    const now = performance.now();
    const cpuPercent = lastSample && cores && now > lastSample.time ? Math.max(0, Math.min(100, (cpu - lastSample.cpu) / ((now - lastSample.time) * 1000) / cores * 100)) : null;
    lastSample = { cpu, time: now };
    const limit = read('/sys/fs/cgroup/memory.max').trim();
    return { cpuPercent, memoryBytes: Number(read('/sys/fs/cgroup/memory.current')), memoryLimitBytes: limit === 'max' ? null : Number(limit) };
  } catch { return null; }
}

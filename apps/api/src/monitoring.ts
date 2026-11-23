import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SystemResources } from '@mgo/protocol';

const CGROUP = '/sys/fs/cgroup';
const read = (file: string): string | undefined => {
  try { return readFileSync(file, 'utf8').trim(); }
  catch { return undefined; }
};
const counter = (value: string | undefined): number | null => {
  if (!value || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const field = (value: string | undefined, key: string) =>
  counter(value?.split('\n').find(line => line.startsWith(key + ' '))?.split(' ')[1]);

function group(controller: string): string | undefined {
  for (const line of read('/proc/self/cgroup')?.split('\n') ?? []) {
    const [, controllers, ...segments] = line.split(':');
    const member = segments.join(':');
    if (controllers?.split(',').includes(controller) && member.startsWith('/') && !member.split('/').includes('..')) {
      return member;
    }
  }
}

export function memoryWorkingSet(usage: number, inactiveFile: number | null) {
  const cache = Math.max(0, Math.min(usage, inactiveFile ?? 0));
  return { memoryBytes: usage - cache, memoryUsageBytes: usage, memoryCacheBytes: inactiveFile === null ? null : cache };
}

let previous: { cpu: number; time: number; scope: string; percent: number | null } | null = null;

export function resourceUsage(): SystemResources {
  const v2 = group('');
  const v2Dir = v2 === undefined ? null : path.join(CGROUP, v2);
  const v1Memory = group('memory');
  const v1Cpu = group('cpuacct');
  const v1MemoryDir = v1Memory === undefined ? null : path.join(CGROUP, 'memory', v1Memory);
  const v1CpuDir = v1Cpu === undefined ? null : ['cpu,cpuacct', 'cpuacct,cpu', 'cpuacct'].map(dir => path.join(CGROUP, dir, v1Cpu)).find(dir => read(path.join(dir, 'cpuacct.usage')) !== undefined);
  const memoryV2 = v2Dir ? counter(read(path.join(v2Dir, 'memory.current'))) : null;
  const memoryV1 = v1MemoryDir ? counter(read(path.join(v1MemoryDir, 'memory.usage_in_bytes'))) : null;
  const memoryStat = memoryV2 !== null && v2Dir ? read(path.join(v2Dir, 'memory.stat'))
    : memoryV1 !== null && v1MemoryDir ? read(path.join(v1MemoryDir, 'memory.stat')) : undefined;
  const memoryLimit = memoryV2 !== null && v2Dir ? counter(read(path.join(v2Dir, 'memory.max')))
    : memoryV1 !== null && v1MemoryDir ? counter(read(path.join(v1MemoryDir, 'memory.limit_in_bytes'))) : null;

  const cpuV2 = v2Dir ? field(read(path.join(v2Dir, 'cpu.stat')), 'usage_usec') : null;
  const cpuV1 = v1CpuDir ? counter(read(path.join(v1CpuDir, 'cpuacct.usage'))) : null;
  const cpuScope = cpuV2 !== null || cpuV1 !== null ? 'cgroup' : 'process';
  const processCpu = process.cpuUsage();
  const cpu = cpuV2 ?? (cpuV1 === null ? processCpu.user + processCpu.system : cpuV1 / 1000);
  const [quota, period] = v2Dir && cpuV2 !== null
    ? (read(path.join(v2Dir, 'cpu.max')) ?? '').split(/\s+/).map(counter)
    : v1CpuDir ? ['cpu.cfs_quota_us', 'cpu.cfs_period_us'].map(name => counter(read(path.join(v1CpuDir, name)))) : [];
  const capacity = os.availableParallelism();
  const cores = quota && period && quota > 0 && period > 0 ? Math.min(capacity, quota / period) : capacity;

  const now = performance.now();
  if (previous?.scope !== cpuScope || now - previous.time >= 1000) {
    const elapsed = previous?.scope === cpuScope ? now - previous.time : 0;
    const utilization = previous && elapsed > 0 ? (cpu - previous.cpu) / (elapsed * 1000 * cores) * 100 : null;
    previous = { cpu, time: now, scope: cpuScope, percent: utilization === null ? null : Math.max(0, Math.min(100, utilization)) };
  }
  return {
    cpuPercent: previous.percent,
    cpuCores: cores,
    ...memoryWorkingSet(memoryV2 ?? memoryV1 ?? process.memoryUsage.rss(), field(memoryStat, memoryV2 !== null ? 'inactive_file' : 'total_inactive_file')),
    memoryLimitBytes: memoryLimit && memoryLimit > 0 ? Math.min(memoryLimit, os.totalmem()) : os.totalmem(),
    memoryScope: memoryV2 !== null || memoryV1 !== null ? 'cgroup' : 'process',
    oomKills: v2Dir ? field(read(path.join(v2Dir, 'memory.events')), 'oom_kill') : null,
  };
}

export function monitoring() {
  return {
    ...resourceUsage(), uptimeSeconds: process.uptime(), sessions: 0, frames: 0, audioBytes: 0,
    nodeVersion: process.version, platform: `${os.platform()} ${os.arch()}`,
  };
}

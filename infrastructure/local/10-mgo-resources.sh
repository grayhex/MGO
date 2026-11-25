#!/bin/sh
# Sample the gateway's own cgroup for the app on the private port.
set -eu

member() {
  awk -F: -v controller="$1" '$2 == controller || (controller != "" && ("," $2 ",") ~ ("," controller ",")) { sub(/^[^:]*:[^:]*:/, ""); print; exit }' /proc/self/cgroup
}

root=/sys/fs/cgroup
unified=$(member '')
if [ -n "$unified" ] && [ -r "$root$unified/memory.current" ]; then
  group=$root$unified
  memory=$group/memory.current
  memory_limit=$group/memory.max
  memory_stat=$group/memory.stat
  inactive=inactive_file
  cpu_stat=$group/cpu.stat
  read -r quota period < "$group/cpu.max" || :
else
  memory_member=$(member memory)
  cpu_member=$(member cpuacct)
  if [ -z "$memory_member" ] || [ -z "$cpu_member" ]; then exit 0; fi
  memory_group=$root/memory$memory_member
  for controller in cpu,cpuacct cpuacct,cpu cpuacct; do
    cpu_group=$root/$controller$cpu_member
    if [ -r "$cpu_group/cpuacct.usage" ]; then break; fi
  done
  memory=$memory_group/memory.usage_in_bytes
  memory_limit=$memory_group/memory.limit_in_bytes
  memory_stat=$memory_group/memory.stat
  inactive=total_inactive_file
  cpu_stat=$cpu_group/cpuacct.usage
  cpu_quota=$root/cpu$(member cpu)
  if [ -r "$cpu_group/cpu.cfs_quota_us" ]; then cpu_quota=$cpu_group; fi
  quota=$(cat "$cpu_quota/cpu.cfs_quota_us" 2>/dev/null || printf max)
  period=$(cat "$cpu_quota/cpu.cfs_period_us" 2>/dev/null || printf 0)
fi
if [ ! -r "$memory" ] || [ ! -r "$cpu_stat" ]; then exit 0; fi

cores=$(nproc)
target=/tmp/mgo-gateway-resources.json
(
  previous_cpu=
  previous_time=
  while :; do
    read -r now _ < /proc/uptime
    cpu=$(awk 'NF == 1 && $1 ~ /^[0-9]+$/ { printf "%.0f", $1 / 1000 } $1 == "usage_usec" { print $2 }' "$cpu_stat")
    awk -v now="$now" -v old_time="$previous_time" -v cpu="$cpu" -v old_cpu="$previous_cpu" \
      -v cores="$cores" -v quota="${quota:-max}" -v period="${period:-0}" -v stamp="$(date +%s)" \
      -v inactive="$inactive" '
        FILENAME == ARGV[1] { if ($1 ~ /^[0-9]+$/) usage = $1 }
        FILENAME == ARGV[2] { limit = $1 }
        FILENAME == ARGV[3] && $1 == inactive { cache = $2 }
        END {
          if (usage == "") exit 1
          memory_cap = limit + 0 > 0 && limit + 0 < 2 ^ 60 ? sprintf("%.0f", limit) : "null"
          if (quota + 0 > 0 && period > 0 && quota / period < cores) cores = quota / period
          percent = "null"
          if (old_cpu != "" && cpu != "" && cpu >= old_cpu && now > old_time && cores > 0) {
            load = (cpu - old_cpu) / ((now - old_time) * 10000 * cores)
            percent = sprintf("%.2f", load > 100 ? 100 : load)
          }
          printf "{\"sampledAt\":%s,\"cpuPercent\":%s,\"memoryBytes\":%.0f,\"memoryLimitBytes\":%s}\n", stamp, percent, (cache <= usage ? usage - cache : 0), memory_cap
        }' "$memory" "$memory_limit" "$memory_stat" > "$target.tmp" && chmod 644 "$target.tmp" && mv -f "$target.tmp" "$target"
    previous_cpu=$cpu
    previous_time=$now
    sleep 5
  done
) < /dev/null > /dev/null 2>&1 &

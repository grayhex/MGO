/** The Docker API has no egress. Only these provider routes go through its internal gateway. */
export function javaSourceFetch(gateway?: string): typeof fetch {
  if (!gateway) return fetch;
  return (input, init) => {
    const url = new URL(String(input));
    return fetch(`${gateway.replace(/\/$/, '')}/java-sources/${url.hostname}${url.pathname}${url.search}`, init);
  };
}

export class RemoteResponseError extends Error {
  constructor(readonly status: number) { super(`Unexpected remote response (HTTP ${status})`); }
}

/** Read a bounded public response. Redirects must stay within the provider's allowed HTTPS hosts. */
export async function readRemote(fetcher: typeof fetch, url: URL, allowed: (url: URL) => boolean, maxBytes: number, signal: AbortSignal, headers?: HeadersInit) {
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed(url)) throw new Error('Unexpected download host');
    const response = await fetcher(url, { signal, redirect: 'manual', ...(headers ? { headers } : {}) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('Missing download redirect');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new RemoteResponseError(response.status);
    }
    if (!response.body || Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new Error('Invalid remote response size');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return { bytes: Buffer.concat(chunks, length), headers: response.headers };
        length += value.length;
        if (length > maxBytes) throw new Error('Remote response exceeded the size limit');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  throw new Error('Too many download redirects');
}

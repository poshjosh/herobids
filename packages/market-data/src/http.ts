export async function fetchJson<T>(params: {
  url: string;
  timeoutMs: number;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  fetchFn?: typeof fetch;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const response = await (params.fetchFn ?? fetch)(params.url, {
      method: params.method,
      headers: params.headers,
      body: params.body,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }

    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}
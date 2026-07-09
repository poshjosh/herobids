/**
 * Typed HTTP error that carries the HTTP status code so callers can
 * branch on it without parsing error messages.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

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
      throw new HttpError(
        `HTTP error: ${response.status} ${response.statusText}`,
        response.status,
      );
    }

    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchText(params: {
  url: string;
  timeoutMs: number;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  fetchFn?: typeof fetch;
}): Promise<string> {
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
      throw new HttpError(
        `HTTP error: ${response.status} ${response.statusText}`,
        response.status,
      );
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}
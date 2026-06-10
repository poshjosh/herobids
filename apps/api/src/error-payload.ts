export interface ApiErrorDetail {
  field?: string;
  code?: string;
  message?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

export function errorPayload(
  error: string,
  message: string,
  params?: Record<string, unknown>,
  extras?: Record<string, unknown>,
) {
  return {
    error,
    message,
    ...(params ? { params } : {}),
    ...(extras ?? {}),
  };
}
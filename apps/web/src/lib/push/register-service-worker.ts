export const SERVICE_WORKER_URL = '/sw.js';
export const SERVICE_WORKER_SCOPE = '/';

export type ServiceWorkerRegistrationOutcome = 'registered' | 'unsupported' | 'failed';

/** The slice of navigator.serviceWorker this module uses, so tests can pass a fake. */
export interface ServiceWorkerContainerLike {
  register(url: string, options?: RegistrationOptions): Promise<unknown>;
}

/** Registration does not prompt for permission. Push permission is requested only from the opt-in button. */
export async function registerServiceWorker(
  container: ServiceWorkerContainerLike | undefined,
): Promise<ServiceWorkerRegistrationOutcome> {
  if (!container) return 'unsupported';
  try {
    await container.register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE });
    return 'registered';
  } catch {
    return 'failed';
  }
}

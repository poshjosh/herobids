export const LOCAL_AUTH_URL_ENVIRONMENTS = ['staging', 'production'] as const;

export const AUTH_URL_ENV_VARS = {
  publicBaseUrl: 'AUTH_PUBLIC_BASE_URL',
  frontendOrigin: 'AUTH_FRONTEND_ORIGIN',
} as const;

export type AuthUrlKey = keyof typeof AUTH_URL_ENV_VARS;

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '0.0.0.0' ||
    hostname.startsWith('127.') ||
    hostname === '[::1]'
  );
}

/**
 * Staging and production must not build login or connection links on a local
 * host. One message per auth URL that is local or unparseable. Other
 * environments return no violations.
 */
export function findLocalhostAuthViolations(
  auth: Partial<Record<AuthUrlKey, string>>,
  environment: string,
): string[] {
  if (!LOCAL_AUTH_URL_ENVIRONMENTS.some((checked) => checked === environment)) return [];
  const violations: string[] = [];
  for (const key of Object.keys(AUTH_URL_ENV_VARS) as AuthUrlKey[]) {
    const value = auth[key];
    if (value === undefined) continue;
    const envVar = AUTH_URL_ENV_VARS[key];
    let hostname: string;
    try {
      hostname = new URL(value).hostname;
    } catch {
      violations.push(`auth.${key} is not a valid URL ("${value}") in a ${environment} environment; set ${envVar} in the environment .env file`);
      continue;
    }
    if (isLocalHostname(hostname)) {
      violations.push(
        `auth.${key} is "${value}" in a ${environment} environment; set ${envVar} in the environment .env file (e.g. https://staging.openaidom.com)`,
      );
    }
  }
  return violations;
}

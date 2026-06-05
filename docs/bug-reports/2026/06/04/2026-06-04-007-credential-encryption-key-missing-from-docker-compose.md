# Bug Report: CREDENTIAL_ENCRYPTION_KEY missing from docker-compose.yaml causes instance crash on start

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-04
- **Summary:** Starting any trading instance that uses a non-default venue account would crash immediately in the worker because `CREDENTIAL_ENCRYPTION_KEY` was not set in `docker-compose.yaml`. The API credential guard (added in bug 006) validates that the venue account has a credential, but the worker still needs the encryption key to decrypt it at runtime.

## Root Cause

`docker-compose.yaml` defined neither `CREDENTIAL_ENCRYPTION_KEY` for the worker service nor for the api service. When the worker's actor factory attempted to decrypt the venue account's credential via AES-256-GCM, it hit this path:

```ts
const encryptionKey = process.env['CREDENTIAL_ENCRYPTION_KEY'];
if (encryptionKey) { ... } else {
  throw new CredentialResolutionError(
    `CREDENTIAL_ENCRYPTION_KEY not set — cannot decrypt credentials for venueAccount ${venueAccountId}`
  );
}
```

`onStartFailed` caught this and immediately marked the instance `crashed`.

The API (`apps/api/src/routes/credentials.ts`) also calls `getEncryptionKey()` when storing credentials, so without the key credentials could not be added at all in a Docker stack started with the base `docker-compose.yaml`.

## Fix

Added `CREDENTIAL_ENCRYPTION_KEY` with a dev-safe 64-hex-char default to both the `api` and `worker` services in `docker-compose.yaml`:

```yaml
CREDENTIAL_ENCRYPTION_KEY: 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
```

A comment notes this must be replaced with a real random key in production. `docker-compose.dev.yaml` inherits this value via the base compose merge.

## Files Changed

- [docker-compose.yaml](../../docker-compose.yaml)

## Verification

- Ran `pnpm lint`
- Result: `tsc --noEmit` completed successfully with no errors

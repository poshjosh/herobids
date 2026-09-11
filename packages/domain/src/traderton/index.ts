// The Traderton REST boundary transport subpath (`@herobids/domain/traderton`).
//
// Exposed as a SUBPATH export (not the top-level barrel) because it pulls
// node:crypto + fetch, which must not enter the browser (apps/web) bundle. Only
// apps/worker + apps/api import from here — both construct a `TradertonClient`
// (the platform injects ownerId + actor VALUES; no trading behaviour). Relocated
// to domain in L3c so both apps can reach it (apps must not import each other).

export * from './contract.js';
export * from './sign.js';
export * from './client.js';

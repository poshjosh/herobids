// Descriptor-source port (Step 10 §3; Step 12 T3.2). The one seam that feeds a
// signed descriptor into the generic trust pipeline (`resolveDescriptorTools`).
//
// `DescriptorWrapper` is imported type-only from the node-only external-backend
// subpath, so this port carries NO runtime dependency on node:crypto and may sit
// in the main `ports` barrel reached by apps/web. The implementation (worker-side)
// owns the node:crypto cost; this interface is pure structure.
import type { DescriptorWrapper } from '../external-backend/descriptor.js';

/**
 * Returns the signed descriptor wrapper for a backend, or `undefined` when none
 * is available (→ a matched skill degrades to instruction-only, DT3). Never
 * throws: an absent or unresolvable source is a degrade, not a crash.
 */
export interface ExternalBackendDescriptorSource {
  getDescriptor(backendId: string): Promise<DescriptorWrapper | undefined> | DescriptorWrapper | undefined;
}

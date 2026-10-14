import { TestProvisioningDefaultsSchema, err, ok, type ExternalBackendReadResult, type Result } from '@herobids/domain';
import type { TradingTestDefaults } from './setup-trading-for-agent.js';

export interface OperatorDefaultsReadBoundary {
  invoke(input: { toolName: string; payload: unknown }): Promise<ExternalBackendReadResult>;
}

/** Read the operator's test-provisioning defaults from Traderton's `get_operator_defaults`. */
export async function loadTestDefaults(boundary: OperatorDefaultsReadBoundary): Promise<Result<TradingTestDefaults, { code: string; message: string }>> {
  const result = await boundary.invoke({ toolName: 'get_operator_defaults', payload: {} });
  if (result.kind !== 'success') {
    return err({ code: 'test_defaults.unavailable', message: 'Trading defaults are unavailable right now.' });
  }
  const parsed = TestProvisioningDefaultsSchema.safeParse(result.data);
  if (!parsed.success) {
    return err({ code: 'test_defaults.invalid_response', message: 'Trading defaults returned an invalid response.' });
  }
  return ok({
    defaultTestCapital: parsed.data.defaultTestCapital,
    defaultTestProvider: parsed.data.defaultTestProvider,
    generatedWalletTestSetupAllowed: parsed.data.generatedWalletTestSetupAllowed,
  });
}

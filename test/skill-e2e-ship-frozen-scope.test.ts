import { afterAll, test } from 'bun:test';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { describeE2ETier, e2eTierEnabled } from './helpers/e2e-gate';
import { EvalCollector } from './helpers/eval-store';
import { runShipFrozenScopeActor, SHIP_FROZEN_SCOPE_SUITE } from './helpers/ship-frozen-scope-actor';

const describeE2E = describeE2ETier('gate');
const collector = e2eTierEnabled('gate') ? new EvalCollector('e2e', undefined, SHIP_FROZEN_SCOPE_SUITE) : null;
describeE2E('/ship frozen review scope converges in two passes', () => {
  test('ship-frozen-scope-convergence', async () => {
    await runShipFrozenScopeActor(entry => collector!.addTest(entry));
  }, CAPTURE_MS);
});
afterAll(async () => { await collector?.finalize(); });

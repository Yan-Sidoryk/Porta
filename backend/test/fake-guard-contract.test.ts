import { FakeClock, FakeGuard } from './fakes.js';
import { runCommandGuardContract } from './command-guard-contract.js';

runCommandGuardContract(() => {
  const clock = new FakeClock();
  return { guard: new FakeGuard(clock), clock };
});

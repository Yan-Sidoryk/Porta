import type {
  AccessGrantRepositoryPort, AccessPolicyPort, ClockPort,
  PushSenderPort, PushTokenRepositoryPort, UserRepositoryPort,
} from '../domain/ports.js';

export const GATE_OPEN_TITLE = 'Gate still open';
export const GATE_OPEN_BODY = 'The gate has not closed. Tap to check it.';

/**
 * Tells everyone entitled to know that the gate has been left open.
 *
 * Entitlement is `AccessPolicyPort.canOperate`, evaluated NOW rather than at
 * registration. "May this person open the gate right now" is exactly the right
 * test for "should they be told it is open": it already knows an owner needs
 * no grant, and revoking a guest's grant silences their alerts without a
 * second rule to keep in step. A disabled account falls out for free.
 *
 * A lookup per token would be wasteful on a hot path. This is not one -- it
 * runs at most once per time the gate is left open.
 */
export class NotifyGateOpenUseCase {
  constructor(
    private tokens: PushTokenRepositoryPort,
    private users: UserRepositoryPort,
    private grants: AccessGrantRepositoryPort,
    private policy: AccessPolicyPort,
    private sender: PushSenderPort,
    private clock: ClockPort,
  ) {}

  async execute(): Promise<void> {
    const registered = await this.tokens.listAll();
    if (registered.length === 0) return;

    const at = this.clock.now();
    const allowed: string[] = [];

    for (const entry of registered) {
      const user = await this.users.findById(entry.userId);
      if (!user || user.disabled) continue;

      const decision = this.policy.canOperate(user, await this.grants.listForUser(user.id), at);
      if (decision.allowed) allowed.push(entry.token);
    }

    if (allowed.length === 0) return;

    // Dead tokens are the sender's report of an uninstalled app. Dropping them
    // here is the only thing that stops the table growing forever.
    const dead = await this.sender.send(allowed, {
      title: GATE_OPEN_TITLE,
      body: GATE_OPEN_BODY,
    });
    for (const token of dead) await this.tokens.remove(token);
  }
}

import { describe, expect, it } from 'vitest';
import { RoleBasedAccessPolicy } from '../domain/access-policy.js';
import type { AccessGrant, User } from '../domain/user.js';
import {
  FakeClock, FakeGrantRepo, FakePushSender, FakePushTokens, FakeUserRepo,
} from '../../test/fakes.js';
import { NotifyGateOpenUseCase } from './notify-gate-open.js';

const NOW = new Date('2026-08-19T12:00:00Z');

const owner: User = {
  id: 'owner1', email: 'o@x.c', passwordHash: 'h',
  role: 'owner', disabled: false, createdAt: new Date('2026-01-01'),
};
const guest: User = { ...owner, id: 'guest1', email: 'g@x.c', role: 'user' };

const grant = (over: Partial<AccessGrant> = {}): AccessGrant => ({
  id: 'g1',
  userId: 'guest1',
  startsAt: new Date('2026-08-19T00:00:00Z'),
  endsAt: new Date('2026-08-20T00:00:00Z'),
  createdBy: 'owner1',
  revokedAt: null,
  ...over,
});

function build(users: User[], grants: AccessGrant[], tokens: { token: string; userId: string }[]) {
  const pushTokens = new FakePushTokens(tokens);
  const sender = new FakePushSender();
  const useCase = new NotifyGateOpenUseCase(
    pushTokens, new FakeUserRepo(users), new FakeGrantRepo(grants),
    new RoleBasedAccessPolicy(), sender, new FakeClock(NOW),
  );
  return { useCase, sender, pushTokens };
}

describe('NotifyGateOpenUseCase', () => {
  it('tells an owner, who needs no grant', async () => {
    const { useCase, sender } = build([owner], [], [{ token: 'A', userId: 'owner1' }]);
    await useCase.execute();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.tokens).toEqual(['A']);
  });

  it('tells a guest whose grant is currently valid', async () => {
    const { useCase, sender } = build([guest], [grant()], [{ token: 'B', userId: 'guest1' }]);
    await useCase.execute();
    expect(sender.sent[0]?.tokens).toEqual(['B']);
  });

  // The whole reason entitlement is checked at SEND time rather than at
  // registration: revoking access has to silence the alerts too, without a
  // second rule to keep in step with the first.
  it('says nothing to a guest whose grant expired or was revoked', async () => {
    const expired = build(
      [guest],
      [grant({ endsAt: new Date('2026-08-19T11:00:00Z') })],
      [{ token: 'B', userId: 'guest1' }],
    );
    await expired.useCase.execute();
    expect(expired.sender.sent).toHaveLength(0);

    const revoked = build(
      [guest],
      [grant({ revokedAt: new Date('2026-08-19T10:00:00Z') })],
      [{ token: 'B', userId: 'guest1' }],
    );
    await revoked.useCase.execute();
    expect(revoked.sender.sent).toHaveLength(0);
  });

  it('says nothing to a guest with no grant at all', async () => {
    const { useCase, sender } = build([guest], [], [{ token: 'B', userId: 'guest1' }]);
    await useCase.execute();
    expect(sender.sent).toHaveLength(0);
  });

  it('says nothing to a disabled account, whatever its role', async () => {
    const { useCase, sender } = build(
      [{ ...owner, disabled: true }], [], [{ token: 'A', userId: 'owner1' }],
    );
    await useCase.execute();
    expect(sender.sent).toHaveLength(0);
  });

  it('sends one batch covering everyone entitled', async () => {
    const { useCase, sender } = build(
      [owner, guest],
      [grant()],
      [{ token: 'A', userId: 'owner1' }, { token: 'B', userId: 'guest1' }],
    );
    await useCase.execute();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.tokens).toEqual(['A', 'B']);
  });

  it('drops a token the push service reports as dead', async () => {
    // An uninstalled app never recovers, so the row goes. Without this they
    // accumulate in the table and are retried forever.
    const pushTokens = new FakePushTokens([{ token: 'A', userId: 'owner1' }]);
    const sender = new FakePushSender(['A']);
    const useCase = new NotifyGateOpenUseCase(
      pushTokens, new FakeUserRepo([owner]), new FakeGrantRepo([]),
      new RoleBasedAccessPolicy(), sender, new FakeClock(NOW),
    );

    await useCase.execute();
    expect(await pushTokens.listAll()).toHaveLength(0);
  });

  it('does not call the push service when nobody is registered', async () => {
    const { useCase, sender } = build([owner], [], []);
    await useCase.execute();
    expect(sender.sent).toHaveLength(0);
  });
});

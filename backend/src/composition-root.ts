import type { Config } from './config.js';
import type {
  ClockPort, GateCommandPort, GateStateSinkPort, PushSenderPort,
  PushTokenRepositoryPort, RateLimiterPort, TokenServicePort,
} from './domain/ports.js';
import { RoleBasedAccessPolicy } from './domain/access-policy.js';
import { AuditedTriggerGate } from './application/audited-trigger.js';
import { TriggerGateUseCase, type TriggerGate } from './application/trigger-gate.js';
import { AuthenticateUserUseCase, RefreshSessionUseCase } from './application/auth.js';
import { IssueAccessGrantUseCase, RevokeAccessGrantUseCase } from './application/access-grants.js';
import { GetGateStatusUseCase, ListAuditEventsUseCase } from './application/queries.js';
import { NotifyGateOpenUseCase } from './application/notify-gate-open.js';
import { openDatabase } from './infrastructure/db/open.js';
import { SqliteUserRepository } from './infrastructure/db/user-repository.js';
import { SqliteAccessGrantRepository } from './infrastructure/db/grant-repository.js';
import { SqliteAuditLog } from './infrastructure/db/audit-log.js';
import { SqliteCommandGuard } from './infrastructure/db/command-guard.js';
import { SqlitePushTokenRepository } from './infrastructure/db/push-token-repository.js';
import { ShellyCloudGateCommandAdapter } from './infrastructure/shelly/gate-command-adapter.js';
import { ReedSwitchStateAdapter } from './infrastructure/shelly/reed-switch-state-adapter.js';
import { SystemClock } from './infrastructure/clock.js';
import { JwtTokenService } from './infrastructure/jwt.js';
import { InMemoryRateLimiter } from './infrastructure/rate-limiter.js';
import { verifyPassword } from './infrastructure/password.js';
import { redact } from './infrastructure/redact.js';

/**
 * Everything the API layer is allowed to know about. Ports and use cases
 * only -- no `Database`, no adapter classes -- so a route cannot reach past
 * its layer, and the API tests can build one of these out of fakes.
 */
export interface Container {
  trigger: TriggerGate;
  gateStatus: GetGateStatusUseCase;
  auditEvents: ListAuditEventsUseCase;
  login: AuthenticateUserUseCase;
  refresh: RefreshSessionUseCase;
  issueGrant: IssueAccessGrantUseCase;
  revokeGrant: RevokeAccessGrantUseCase;
  /** Exposed for POST /auth/logout, which is a port call and not a use case. */
  tokens: TokenServicePort;
  limiter: RateLimiterPort;
  clock: ClockPort;
  /**
   * The write side of gate position. Exposed for the webhook route, which may
   * report state and must never be able to command the gate -- the narrow
   * type is the thing that makes that structural rather than a promise.
   */
  gateStateSink: GateStateSinkPort;
  gateStateWebhookToken: string;
  /**
   * The concrete adapter, for server.ts to hand to the reconciliation poll.
   * The poll is started there rather than here so that building a container
   * in a test does not open a socket to Shelly.
   */
  gateStateAdapter: ReedSwitchStateAdapter;
  pushTokens: PushTokenRepositoryPort;
  /** Built here so server.ts can hand it to the gate-open alarm. */
  notifyGateOpen: NotifyGateOpenUseCase;
  close(): void;
}

/**
 * The composition root: the only file that names a concrete adapter. Wired by
 * hand, no DI container -- there are a dozen objects here and a framework
 * would hide the one line that matters (see `gateCommand`).
 */
export function buildContainer(config: Config, pushSender: PushSenderPort): Container {
  const clock = new SystemClock();
  const db = openDatabase(config.databasePath);

  // The one line to change for local network control. Swap this for a
  // LocalRpcGateCommandAdapter or MqttGateCommandAdapter -- nothing else moves.
  const gateCommand: GateCommandPort = new ShellyCloudGateCommandAdapter(config.shelly);
  // The reed contact replaces UnknownPositionStateAdapter, which stays in the
  // tree unused as the documented fallback for a deployment with no sensor.
  const gateState = new ReedSwitchStateAdapter(clock, config.gateState.staleAfterMs);

  const users = new SqliteUserRepository(db);
  const grants = new SqliteAccessGrantRepository(db);
  const audit = new SqliteAuditLog(db);
  const pushTokens = new SqlitePushTokenRepository(db);
  const tokens = new JwtTokenService(config.jwtSecret, db, clock);

  return {
    // Auditing wraps the use case: the paths that return early -- unknown
    // user, access denied -- are the ones that most need recording.
    trigger: new AuditedTriggerGate(
      new TriggerGateUseCase(
        users, grants, new RoleBasedAccessPolicy(), new SqliteCommandGuard(db, clock),
        gateCommand, clock, config.gateCooldownMs, gateState,
      ),
      audit, clock,
      // The REAL redactor, not `(s) => s`. An audit row holds the raw adapter
      // error from a failed pulse, and a failed Shelly fetch embeds
      // ?auth_key=<account-wide secret> in the URL it reports.
      redact,
    ),
    gateStatus: new GetGateStatusUseCase(gateState, clock),
    auditEvents: new ListAuditEventsUseCase(audit),
    // The real argon2id verifier. A stub here accepts every password, which
    // is why AuthenticateUserUseCase takes the function rather than importing
    // one -- the substitution is visible at exactly this line.
    login: new AuthenticateUserUseCase(users, tokens, verifyPassword),
    refresh: new RefreshSessionUseCase(users, tokens),
    issueGrant: new IssueAccessGrantUseCase(users, grants),
    revokeGrant: new RevokeAccessGrantUseCase(users, grants, clock),
    tokens,
    limiter: new InMemoryRateLimiter(clock),
    clock,
    gateStateSink: gateState,
    gateStateWebhookToken: config.gateState.webhookToken,
    gateStateAdapter: gateState,
    pushTokens,
    notifyGateOpen: new NotifyGateOpenUseCase(
      pushTokens, users, grants, new RoleBasedAccessPolicy(), pushSender, clock,
    ),
    close: () => db.close(),
  };
}

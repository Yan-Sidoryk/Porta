import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import type { AuditEvent, GateStatusResponse } from '@gate/shared';
import { getAudit, getStatus, logout, trigger, type ApiFailure } from '../api';
import {
  canTap, controllerView, cooldownProgress, nextState, secondsLeft, tapIsFinished,
  type GateUiState,
} from '../gate-machine';
import { Ionicons } from '@expo/vector-icons';
import { GateButton } from '../components/GateButton';
import { StatusPanel } from '../components/StatusPanel';
import { ActivityList } from '../components/ActivityList';
import { SettingsMenu } from '../components/SettingsMenu';
import {
  authenticate, checkAvailability, isLockEnabled, setLockEnabled, type Availability,
} from '../biometrics';
import { colors, space, type as typography } from '../theme';

interface Props {
  onSignedOut: () => void;
}

/** Fast enough for a countdown to look live, slow enough to be free. */
const TICK_MS = 250;

/** How long a result message stays before clearing itself. Tune to taste. */
const BANNER_VISIBLE_MS = 10_000;

/**
 * Space the message strip always occupies, whether it holds nothing, one line
 * or three. Reserved so the button below never moves: a control that shifts
 * under a thumb as a message arrives is how a second tap gets sent by accident.
 * A minimum rather than a fixed height, so large accessibility text grows
 * instead of being clipped.
 */
const BANNER_MIN_HEIGHT = 80;

interface BannerMessage {
  text: string;
  tone: string;
}

export function GateScreen({ onSignedOut }: Props) {
  const [state, setState] = useState<GateUiState>({ kind: 'idle' });
  /** null until the first read lands -- rendered as "checking", not "offline". */
  const [reading, setReading] = useState<GateStatusResponse | ApiFailure | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  /**
   * One id per user-initiated tap, held until the gate service gives a
   * definite answer. A retry after a network failure must reuse it: the pulse
   * may already have fired, and a fresh id would send a second one -- which
   * stops a moving gate.
   */
  const tapId = useRef<string | null>(null);

  /**
   * The message strip is its own state, deliberately not derived from
   * `state`. Dismissing a message must never touch the cooldown -- if the two
   * shared a value, a banner timing out after 10s would re-enable the button
   * in the middle of a 20s post-timeout window.
   */
  const [banner, setBanner] = useState<BannerMessage | null>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopBannerTimer = (): void => {
    if (bannerTimer.current !== null) {
      clearTimeout(bannerTimer.current);
      bannerTimer.current = null;
    }
  };

  /** `sticky` messages stay until replaced -- used while a pulse is in flight. */
  const showBanner = (text: string, tone: string, sticky = false): void => {
    stopBannerTimer();
    setBanner({ text, tone });
    if (!sticky) {
      bannerTimer.current = setTimeout(() => setBanner(null), BANNER_VISIBLE_MS);
    }
  };

  // Leaving the screen must not fire a setState later.
  useEffect(() => stopBannerTimer, []);

  const [menuOpen, setMenuOpen] = useState(false);
  const [biometricOn, setBiometricOn] = useState(false);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [togglingLock, setTogglingLock] = useState(false);

  // Read once. Hardware and enrolment do not change while the app is open.
  useEffect(() => {
    void checkAvailability().then(setAvailability);
    void isLockEnabled().then(setBiometricOn);
  }, []);

  const openMenu = (): void => setMenuOpen(true);

  /**
   * Turning the lock ON prompts first and only saves if the prompt succeeds.
   * Enabling it on the word of a sensor nobody has tested is how someone ends
   * up locked out on the next launch.
   *
   * Turning it OFF is not gated behind a prompt. The tokens it guards are
   * already reachable in this session -- demanding a fingerprint to lower a
   * setting would add friction without adding protection.
   */
  const toggleBiometric = async (next: boolean): Promise<void> => {
    setTogglingLock(true);
    try {
      if (!next) {
        await setLockEnabled(false);
        setBiometricOn(false);
        return;
      }

      const proof = await authenticate('Confirm to turn on the lock');
      if (!proof.ok) {
        showBanner(proof.reason, colors.warn);
        return;
      }
      await setLockEnabled(true);
      setBiometricOn(true);
    } finally {
      setTogglingLock(false);
    }
  };

  // Only ticks while something is counting down, so an idle screen is not
  // waking the JS thread four times a second.
  const counting = state.kind === 'success' || (state.kind === 'error' && state.until !== undefined);
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [counting]);

  /**
   * The activity list only reads the backend's own database, so it is cheap
   * and safe to pull often.
   */
  const refreshActivity = useCallback(async (): Promise<void> => {
    const events = await getAudit();
    if (Array.isArray(events)) setEvents(events);
    else if (events.code === 'SESSION_EXPIRED') onSignedOut();
  }, [onSignedOut]);

  /**
   * This one reaches Shelly Cloud, which is rate limited to one request per
   * second across the whole backend. Deliberately NOT called after a tap: the
   * pulse has just spent that slot, and reachability lags by up to a minute
   * anyway, so a read one second later cannot say anything new -- it would
   * only fail and make the screen look like the controller had dropped.
   */
  const refreshStatus = useCallback(async (): Promise<void> => {
    const status = await getStatus();
    if ('ok' in status && status.ok === false && status.code === 'SESSION_EXPIRED') {
      onSignedOut();
      return;
    }
    setReading(status);
  }, [onSignedOut]);

  useEffect(() => {
    void refreshStatus();
    void refreshActivity();
  }, [refreshStatus, refreshActivity]);

  const onTap = async (): Promise<void> => {
    if (!canTap(state, Date.now())) return;

    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    tapId.current ??= Crypto.randomUUID();
    setState({ kind: 'sending' });
    showBanner('Sending the pulse...', colors.textDim, true);

    const reply = await trigger(tapId.current);
    const at = Date.now();
    setNow(at);

    const ui = nextState(reply, at);
    setState(ui);

    if (ui.kind === 'sending') {
      // ATTEMPT_IN_PROGRESS: the earlier tap is still running. Not an error,
      // and it stays put rather than timing out, because the honest thing to
      // show is that work is still outstanding.
      showBanner('Still sending -- your earlier tap is on its way', colors.textDim, true);
    } else if (ui.kind === 'success') {
      showBanner(ui.replayed ? 'Already sent -- not repeated' : 'Pulse sent', colors.ok);
    } else if (ui.kind === 'error') {
      showBanner(ui.message, colors.danger);
    }

    if (tapIsFinished(reply)) tapId.current = null;

    if (reply.ok) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (reply.code === 'SESSION_EXPIRED') {
      onSignedOut();
      return;
    } else if (reply.code !== 'ATTEMPT_IN_PROGRESS') {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }

    // Activity only. See refreshStatus for why the controller is not re-read.
    void refreshActivity();
  };

  const tappable = canTap(state, now);
  const window = state.kind === 'success'
    ? { until: state.until, totalMs: state.totalMs }
    : state.kind === 'error' && state.until !== undefined
      ? { until: state.until, totalMs: state.totalMs ?? 0 }
      : null;
  const waiting = window ? secondsLeft(window.until, now) : 0;

  const label = state.kind === 'sending'
    ? 'Sending...'
    : waiting > 0 ? `Wait ${waiting}s` : 'Open / close gate';

  const sublabel = state.kind === 'sending'
    ? 'do not tap again'
    : waiting > 0 ? 'gate is moving' : 'one pulse';

  return (
    <>
    <SettingsMenu
      visible={menuOpen}
      onClose={() => setMenuOpen(false)}
      biometricOn={biometricOn}
      biometricLabel={availability?.available ? availability.label : 'Biometric lock'}
      biometricBlockedReason={availability && !availability.available ? availability.reason : null}
      busy={togglingLock}
      onToggleBiometric={(next) => { void toggleBiometric(next); }}
      onSignOut={() => {
        setMenuOpen(false);
        void logout().finally(onSignedOut);
      }}
    />

    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: space.lg, paddingTop: space.xl, gap: space.lg }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.textDim}
          // An explicit pull is the user asking, so both are re-read here.
          onRefresh={() => {
            stopBannerTimer();
            setBanner(null);
            // Also un-sticks a screen left in `sending` by an
            // ATTEMPT_IN_PROGRESS, which otherwise has nothing to resolve it.
            // Safe: the backend guard still rejects a genuinely early tap.
            setState((current) => (current.kind === 'sending' ? { kind: 'idle' } : current));
            setRefreshing(true);
            void Promise.all([refreshStatus(), refreshActivity()])
              .finally(() => setRefreshing(false));
          }}
        />
      }
    >
      {/* The dots share the status line rather than sitting in a bar of their
          own: one less row of chrome above the only thing that matters.
          Aligned to the top so they sit level with the headline, not with the
          middle of the panel once the "checked at" line appears under it. */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <StatusPanel view={controllerView(reading)} />
        </View>
        <Pressable
          onPress={openMenu}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Settings"
          style={{ padding: space.sm, marginRight: -space.sm }}
        >
          <Ionicons name="ellipsis-vertical" size={22} color={colors.textDim} />
        </Pressable>
      </View>

      <Banner message={banner} />

      {/* Low and centred: within thumb reach one-handed, which is how this is
          actually used -- standing at a gate, often in the rain. */}
      <View style={{ alignItems: 'center', paddingVertical: space.lg }}>
        <GateButton
          label={label}
          sublabel={sublabel}
          disabled={!tappable}
          progress={window ? cooldownProgress(window.until, now, window.totalMs) : 0}
          onPress={() => { void onTap(); }}
        />
      </View>

      <View style={{ gap: space.sm }}>
        <Text style={{ ...typography.title, color: colors.text }}>Recent activity</Text>
        <ActivityList events={events} />
      </View>

    </ScrollView>
    </>
  );
}

/**
 * The message strip.
 *
 * The outer view always occupies BANNER_MIN_HEIGHT, empty or not, so nothing
 * below it moves as messages come and go. Three lines are allowed before
 * truncation, which every message in gate-machine.ts fits inside.
 */
function Banner({ message }: { message: BannerMessage | null }) {
  return (
    <View style={{ minHeight: BANNER_MIN_HEIGHT, justifyContent: 'center' }}>
      {message ? (
        <View
          style={{
            borderLeftWidth: 4,
            borderLeftColor: message.tone,
            backgroundColor: colors.surface,
            padding: space.md,
            borderRadius: 8,
          }}
        >
          <Text numberOfLines={3} style={{ ...typography.body, color: colors.text }}>
            {message.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

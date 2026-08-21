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
import { GateButton } from '../components/GateButton';
import { StatusPanel } from '../components/StatusPanel';
import { ActivityList } from '../components/ActivityList';
import { colors, space, type as typography } from '../theme';

interface Props {
  onSignedOut: () => void;
}

/** Fast enough for a countdown to look live, slow enough to be free. */
const TICK_MS = 250;

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

    const reply = await trigger(tapId.current);
    const at = Date.now();
    setNow(at);
    setState(nextState(reply, at));

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
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: space.lg, paddingTop: space.xl, gap: space.lg }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.textDim}
          // An explicit pull is the user asking, so both are re-read here.
          onRefresh={() => {
            setRefreshing(true);
            void Promise.all([refreshStatus(), refreshActivity()])
              .finally(() => setRefreshing(false));
          }}
        />
      }
    >
      <StatusPanel view={controllerView(reading)} />

      <Banner state={state} />

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

      <Pressable onPress={() => { void logout().finally(onSignedOut); }} style={{ paddingVertical: space.md }}>
        <Text style={{ ...typography.small, color: colors.textDim }}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

/**
 * The message strip. `sending` is not an error and neither is
 * ATTEMPT_IN_PROGRESS, which the machine already folds into `sending`.
 */
function Banner({ state }: { state: GateUiState }) {
  if (state.kind === 'idle') return null;

  const tone = state.kind === 'error' ? colors.danger
    : state.kind === 'success' ? colors.ok
      : colors.textDim;

  const text = state.kind === 'sending' ? 'Sending the pulse...'
    : state.kind === 'success' ? (state.replayed ? 'Already sent -- not repeated' : 'Pulse sent')
      : state.message;

  return (
    <View
      style={{
        borderLeftWidth: 4,
        borderLeftColor: tone,
        backgroundColor: colors.surface,
        padding: space.md,
        borderRadius: 8,
      }}
    >
      <Text style={{ ...typography.body, color: colors.text }}>{text}</Text>
    </View>
  );
}

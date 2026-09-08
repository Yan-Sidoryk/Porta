import type { PushSenderPort } from '../domain/ports.js';
import { redact } from './redact.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const TIMEOUT_MS = 10_000;

/** Expo accepts up to 100 messages per request. */
const BATCH_SIZE = 100;

/**
 * The one ticket status worth acting on: the app was uninstalled, or the
 * token was otherwise retired. It never recovers, so the row is deleted
 * rather than retried forever.
 */
const DEAD = 'DeviceNotRegistered';

interface Ticket {
  status?: string;
  details?: { error?: string };
}

/**
 * Expo's push service. No SDK: this is one POST with a JSON array, and a
 * dependency for that would be more surface than code.
 *
 * ponytail: only the immediate ticket response is inspected. Expo also offers
 * delivery RECEIPTS, fetched minutes later, which report failures the ticket
 * could not know about yet -- an FCM rejection, say. That is a second
 * mechanism with its own storage and schedule; add it if alerts start going
 * quietly missing.
 */
export class ExpoPushSender implements PushSenderPort {
  constructor(private readonly log: { warn: (payload: object, message: string) => void }) {}

  async send(tokens: string[], message: { title: string; body: string }): Promise<string[]> {
    const dead: string[] = [];

    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const batch = tokens.slice(i, i + BATCH_SIZE);
      dead.push(...await this.sendBatch(batch, message));
    }
    return dead;
  }

  private async sendBatch(
    tokens: string[],
    message: { title: string; body: string },
  ): Promise<string[]> {
    const body = tokens.map((to) => ({
      to,
      title: message.title,
      body: message.body,
      // The gate being left open is worth a sound and a heads-up banner; it is
      // the whole reason someone turned this on.
      priority: 'high',
      channelId: 'default',
    }));

    let reply: unknown;
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        // Never throw at the alarm: a push service having a bad day must not
        // take down the timer that watches the gate.
        this.log.warn({ status: response.status }, 'expo push rejected the request');
        return [];
      }
      reply = await response.json();
    } catch (error) {
      this.log.warn({ detail: redact(String(error)) }, 'expo push unreachable');
      return [];
    }

    // Tickets come back in request order, so index maps to token.
    const tickets = (reply as { data?: Ticket[] } | null)?.data;
    if (!Array.isArray(tickets)) return [];

    const dead: string[] = [];
    tickets.forEach((ticket, index) => {
      if (ticket.status !== 'error') return;
      const token = tokens[index];
      if (token !== undefined && ticket.details?.error === DEAD) dead.push(token);
      else this.log.warn({ error: ticket.details?.error ?? 'unknown' }, 'expo push ticket failed');
    });
    return dead;
  }
}

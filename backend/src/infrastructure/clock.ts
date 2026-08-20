import type { ClockPort } from '../domain/ports.js';

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}

/**
 * Single time source for scheduling decisions. Production uses the wall clock of the process
 * (NTP-synchronised hosts assumed). Tests inject a fake clock to exercise UTC-hour boundaries.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class ManualClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(next: Date): void {
    this.current = new Date(next.getTime());
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Start of the fixed UTC hour window containing `at`. */
export function utcHourStart(at: Date): Date {
  const d = new Date(at.getTime());
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/** Start of the next fixed UTC hour window after `at`. */
export function nextUtcHour(at: Date): Date {
  return new Date(utcHourStart(at).getTime() + 3_600_000);
}

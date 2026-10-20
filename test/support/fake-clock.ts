/**
 * **The smallest fake clock that drives the real `Engine`** (unreleased, card `t_346af318`).
 *
 * The card's acceptance check is "zero live intervals and zero live timeouts after five mounts",
 * which cannot be observed from a real clock without waiting for the timers — and cannot be
 * observed at all unless the *live* handles are counted rather than assumed. So this replaces the
 * four timer globals with a recorder that also knows when each timer is due, and `advance(ms)` runs
 * the ones that fall inside the window. The engine is not mocked or instrumented: it calls
 * `setInterval`/`setTimeout` exactly as it does on the phone, and this counts them.
 *
 * It is deliberately a few dozen lines of `Map`, not a scheduler: the engine's timers are a 33 ms
 * poll, a 100 ms meter, one 15 s start deadline and one 300 ms resume window. A timer library would
 * be a much larger mechanism for the same four numbers.
 *
 * `advance` flushes the microtask queue after every due timer, because the poll's own work is a
 * promise (`pollSnapshot` awaits the bridge) and a tick whose answer lands after the window is not
 * a tick that happened.
 */

interface FakeTimer {
  id: number;
  due: number;
  /** `null` for a timeout, the period for an interval. */
  every: number | null;
  fn: () => void;
}

export interface FakeClock {
  /** How many intervals are live right now — the number the card asks to be zero. */
  intervals(): number;
  /** How many timeouts are live right now. */
  timeouts(): number;
  /** Advance the fake clock, running every timer that falls due inside the window. */
  advance(ms: number): Promise<void>;
  /** Put the real timer globals back. */
  restore(): void;
}

/** One turn of the event loop, with the real globals — never the fake ones. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function installFakeClock(): FakeClock {
  const scope = globalThis as unknown as Record<string, unknown>;
  const original = {
    setTimeout: scope.setTimeout,
    setInterval: scope.setInterval,
    clearTimeout: scope.clearTimeout,
    clearInterval: scope.clearInterval,
  };

  let now = 0;
  let nextId = 1;
  const live = new Map<number, FakeTimer>();

  const add = (fn: () => void, ms: number, period: number | null): number => {
    const id = nextId;
    nextId += 1;
    // A timeout fires once at its delay; an interval fires at its period and again every period.
    const delay = period === null ? Math.max(0, Number.isFinite(ms) ? ms : 0) : period;
    live.set(id, { id, due: now + delay, every: period, fn });
    return id;
  };
  const drop = (handle: unknown): void => {
    if (typeof handle === 'number') live.delete(handle);
  };

  scope.setTimeout = ((fn: () => void, ms?: number) => add(fn, Number(ms ?? 0), null)) as unknown as typeof setTimeout;
  scope.setInterval = ((fn: () => void, ms?: number) => {
    const period = Math.max(1, Number.isFinite(Number(ms)) ? Number(ms) : 0);
    return add(fn, period, period);
  }) as unknown as typeof setInterval;
  scope.clearTimeout = drop as unknown as typeof clearTimeout;
  scope.clearInterval = drop as unknown as typeof clearInterval;

  const count = (every: boolean): number => [...live.values()].filter((timer) => (timer.every !== null) === every).length;

  return {
    intervals: () => count(true),
    timeouts: () => count(false),
    async advance(ms: number): Promise<void> {
      const end = now + ms;
      /* The guard is a stuck-loop report, not a budget: 10 000 due timers in one window is not this
       * engine, and a loop that reached it would otherwise hang the suite instead of failing it. */
      for (let guard = 0; guard < 10_000; guard += 1) {
        const next = [...live.values()]
          .filter((timer) => timer.due <= end)
          .sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        now = next.due;
        if (next.every === null) live.delete(next.id);
        else next.due = now + next.every;
        next.fn();
        await flush();
      }
      now = end;
      await flush();
    },
    restore(): void {
      scope.setTimeout = original.setTimeout;
      scope.setInterval = original.setInterval;
      scope.clearTimeout = original.clearTimeout;
      scope.clearInterval = original.clearInterval;
      live.clear();
    },
  };
}

/**
 * The two globals the engine's constructor touches on the native path: it builds its web element
 * even when the phone's player is the one making the sound. Nothing in these tests plays through
 * it. Returns the restore function.
 */
export function stubAudio(): () => void {
  const scope = globalThis as unknown as Record<string, unknown>;
  const previous = scope.Audio;
  class StubAudio {
    src = '';
    duration = 0;
    currentTime = 0;
    paused = true;
    volume = 1;
    preload = '';
    crossOrigin: string | null = null;
    play(): Promise<void> {
      return Promise.resolve();
    }
    pause(): void {}
    load(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
    removeAttribute(): void {}
    setAttribute(): void {}
  }
  scope.Audio = StubAudio;
  return () => {
    scope.Audio = previous;
  };
}

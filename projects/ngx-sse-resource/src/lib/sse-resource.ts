import { isPlatformServer } from '@angular/common';
import {
  DestroyRef,
  InjectionToken,
  Injector,
  PLATFORM_ID,
  Signal,
  assertInInjectionContext,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';

/** Anything that can be constructed like the browser `EventSource`. */
export type EventSourceConstructor = new (url: string, init?: EventSourceInit) => EventSource;

/**
 * The `EventSource` constructor used by `sseResource`. Defaults to the global
 * `EventSource`, or `undefined` where there is none (Node, SSR). Replace it in
 * tests with a fake, or in apps with a polyfill.
 */
export const SSE_EVENT_SOURCE = new InjectionToken<EventSourceConstructor | undefined>(
  'SSE_EVENT_SOURCE',
  {
    providedIn: 'root',
    factory: () => (typeof EventSource === 'undefined' ? undefined : EventSource),
  },
);

export type SseStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

export interface SseBackoff {
  /** Delay before the first reconnect. Default 500. */
  initialDelayMs?: number;
  /** Upper bound for any delay. Default 10000. */
  maxDelayMs?: number;
  /** Each failed attempt multiplies the delay by this. Default 2. */
  factor?: number;
  /** Give up after this many failed attempts in a row. Default Infinity. */
  maxAttempts?: number;
}

export interface SseResourceOptions<T> {
  /** Event name or names to listen to. Default `'message'` (events without an `event:` field). */
  event?: string | readonly string[];
  /** Turns `event.data` into a value. Default `JSON.parse`. */
  parse?: (data: string, event: MessageEvent<string>) => T;
  /** Return true to close the stream after this value, for example on a `done` event. */
  until?: (value: T, event: MessageEvent<string>) => boolean;
  /**
   * - an object (default `{}`): close on error and reconnect with exponential backoff.
   * - `'browser'`: let the browser reconnect on its own. Honors `retry:` and sends `Last-Event-ID`.
   * - `false`: never reconnect. An error ends the stream with status `'error'`.
   */
  reconnect?: SseBackoff | 'browser' | false;
  /** Passed to `EventSource`. Default false. */
  withCredentials?: boolean;
  /**
   * On a backoff reconnect, append the last received event id to the url as
   * this query parameter, for example `lastEventId`. Off by default.
   */
  lastEventIdParam?: string;
  /** Use this injector instead of the current injection context. */
  injector?: Injector;
}

export interface SseResource<T> {
  /** The last parsed value, `undefined` until the first event. */
  readonly value: Signal<T | undefined>;
  readonly status: Signal<SseStatus>;
  /** The last error: what `parse` threw, or an `SseConnectionError`. Cleared by the next value or open. */
  readonly error: Signal<unknown>;
  /** The `id:` of the last event received, if the server sends ids. */
  readonly lastEventId: Signal<string | undefined>;
  /** Close the connection and cancel any pending reconnect. A later url change opens a new one. */
  close(): void;
}

/** Put in `error()` when the connection fails. `EventSource` gives no detail beyond the event. */
export class SseConnectionError extends Error {
  constructor(
    readonly url: string,
    readonly event: Event,
  ) {
    super(`SSE connection to ${url} failed`);
    this.name = 'SseConnectionError';
  }
}

const CONNECTING = 0;
const RESERVED = ['open', 'error'];

/**
 * Opens a Server-Sent Events stream and exposes it as signals.
 *
 * The url is reactive: when it changes, the old connection closes and a new
 * one opens. `null` or `undefined` means no connection (status `'idle'`).
 * On the server, or where `EventSource` does not exist, it stays idle.
 */
export function sseResource<T = unknown>(
  url: () => string | null | undefined,
  options: SseResourceOptions<T> = {},
): SseResource<T> {
  if (!options.injector) {
    assertInInjectionContext(sseResource);
  }
  const injector = options.injector ?? inject(Injector);

  const events = typeof options.event === 'string' ? [options.event] : (options.event ?? ['message']);
  for (const name of events) {
    if (RESERVED.includes(name)) {
      throw new Error(`sseResource: "${name}" is an EventSource event, not a server event name`);
    }
  }
  const parse = options.parse ?? (JSON.parse as (data: string) => T);
  const mode = options.reconnect ?? {};
  const backoff = typeof mode === 'object' ? mode : undefined;
  const initialDelayMs = backoff?.initialDelayMs ?? 500;
  const maxDelayMs = backoff?.maxDelayMs ?? 10_000;
  const factor = backoff?.factor ?? 2;
  const maxAttempts = backoff?.maxAttempts ?? Infinity;

  const value = signal<T | undefined>(undefined);
  const status = signal<SseStatus>('idle');
  const error = signal<unknown>(undefined);
  const lastEventId = signal<string | undefined>(undefined);

  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let started = false;
  let closedEarly = false;

  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    source?.close();
    source = undefined;
  };

  const resource: SseResource<T> = {
    value: value.asReadonly(),
    status: status.asReadonly(),
    error: error.asReadonly(),
    lastEventId: lastEventId.asReadonly(),
    close() {
      if (!started) closedEarly = true;
      stop();
      attempts = 0;
      if (status() !== 'idle') status.set('closed');
    },
  };

  const Ctor = injector.get(SSE_EVENT_SOURCE);
  if (!Ctor || isPlatformServer(injector.get(PLATFORM_ID))) {
    return resource;
  }

  const connect = (target: string, isReconnect: boolean) => {
    const id = lastEventId();
    const href =
      isReconnect && options.lastEventIdParam && id !== undefined
        ? `${target}${target.includes('?') ? '&' : '?'}${encodeURIComponent(options.lastEventIdParam)}=${encodeURIComponent(id)}`
        : target;
    const es = new Ctor(href, { withCredentials: options.withCredentials ?? false });
    source = es;
    status.set(isReconnect ? 'reconnecting' : 'connecting');

    es.addEventListener('open', () => {
      if (es !== source) return;
      attempts = 0;
      error.set(undefined);
      status.set('open');
    });

    es.addEventListener('error', (event) => {
      if (es !== source) return;
      error.set(new SseConnectionError(target, event));
      if (mode === 'browser' && es.readyState === CONNECTING) {
        status.set('reconnecting');
        return;
      }
      stop();
      if (!backoff || attempts >= maxAttempts) {
        status.set('error');
        return;
      }
      const delay = Math.min(maxDelayMs, initialDelayMs * factor ** attempts);
      attempts++;
      status.set('reconnecting');
      timer = setTimeout(() => {
        timer = undefined;
        connect(target, true);
      }, delay);
    });

    const onMessage = (event: Event) => {
      if (es !== source) return;
      const message = event as MessageEvent<string>;
      if (message.lastEventId) lastEventId.set(message.lastEventId);
      let parsed: T;
      try {
        parsed = parse(message.data, message);
      } catch (e) {
        error.set(e);
        return;
      }
      value.set(parsed);
      error.set(undefined);
      if (options.until?.(parsed, message)) {
        stop();
        status.set('closed');
      }
    };
    for (const name of events) {
      es.addEventListener(name, onMessage);
    }
  };

  const currentUrl = computed(() => url() ?? undefined);

  effect(
    () => {
      const target = currentUrl();
      untracked(() => {
        const first = !started;
        started = true;
        stop();
        attempts = 0;
        if (!first) {
          value.set(undefined);
          error.set(undefined);
          lastEventId.set(undefined);
        }
        if (first && closedEarly) {
          status.set('closed');
        } else if (target === undefined) {
          status.set('idle');
        } else {
          connect(target, false);
        }
      });
    },
    { injector },
  );

  injector.get(DestroyRef).onDestroy(() => {
    stop();
    status.set('closed');
  });

  return resource;
}

import {
  EnvironmentInjector,
  Injector,
  PLATFORM_ID,
  createEnvironmentInjector,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  SSE_EVENT_SOURCE,
  SseConnectionError,
  SseResource,
  SseResourceOptions,
  sseResource,
} from './sse-resource';

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  static get last(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }

  readyState = 0;
  readonly withCredentials: boolean;

  constructor(
    readonly url: string,
    init?: EventSourceInit,
  ) {
    super();
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  get closed(): boolean {
    return this.readyState === 2;
  }

  close(): void {
    this.readyState = 2;
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  emit(data: string, type = 'message', id = ''): void {
    this.dispatchEvent(new MessageEvent(type, { data, lastEventId: id }));
  }

  /** `readyState` after the error: 0 means the browser reconnects, 2 means it gave up. */
  fail(readyState = 2): void {
    this.readyState = readyState;
    this.dispatchEvent(new Event('error'));
  }
}

function setup(providers: unknown[] = []): void {
  TestBed.configureTestingModule({
    providers: [{ provide: SSE_EVENT_SOURCE, useValue: FakeEventSource }, ...(providers as [])],
  });
}

function create<T = unknown>(
  url: () => string | null | undefined,
  options?: SseResourceOptions<T>,
): SseResource<T> {
  const resource = TestBed.runInInjectionContext(() => sseResource<T>(url, options));
  TestBed.tick();
  return resource;
}

beforeEach(() => {
  FakeEventSource.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sseResource values', () => {
  beforeEach(() => setup());

  it('connects, opens and parses JSON by default', () => {
    const res = create<{ n: number }>(() => '/events');
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.last.url).toBe('/events');
    expect(res.status()).toBe('connecting');
    expect(res.value()).toBeUndefined();

    FakeEventSource.last.open();
    expect(res.status()).toBe('open');

    FakeEventSource.last.emit('{"n":1}', 'message', '1');
    expect(res.value()).toEqual({ n: 1 });
    expect(res.lastEventId()).toBe('1');
    FakeEventSource.last.emit('{"n":2}');
    expect(res.value()).toEqual({ n: 2 });
  });

  it('listens only to the named event', () => {
    const res = create<number>(() => '/events', { event: 'progress' });
    const es = FakeEventSource.last;
    es.open();
    es.emit('1', 'message');
    expect(res.value()).toBeUndefined();
    es.emit('2', 'progress');
    expect(res.value()).toBe(2);
  });

  it('listens to several named events and passes the event to parse', () => {
    const res = create<{ type: string; data: unknown }>(() => '/events', {
      event: ['rendering', 'done'],
      parse: (data, event) => ({ type: event.type, data: JSON.parse(data) }),
    });
    const es = FakeEventSource.last;
    es.emit('{"completed":1}', 'rendering');
    expect(res.value()).toEqual({ type: 'rendering', data: { completed: 1 } });
    es.emit('{"bytes":10}', 'done');
    expect(res.value()).toEqual({ type: 'done', data: { bytes: 10 } });
  });

  it('accepts an identity parse', () => {
    const res = create<string>(() => '/events', { parse: (data) => data });
    FakeEventSource.last.emit('plain text');
    expect(res.value()).toBe('plain text');
  });

  it('reports a parse error without closing the stream', () => {
    const res = create<{ n: number }>(() => '/events');
    const es = FakeEventSource.last;
    es.open();
    es.emit('{"n":1}');
    es.emit('not json');
    expect(res.error()).toBeInstanceOf(SyntaxError);
    expect(res.value()).toEqual({ n: 1 });
    expect(res.status()).toBe('open');
    expect(es.closed).toBe(false);

    es.emit('{"n":2}');
    expect(res.value()).toEqual({ n: 2 });
    expect(res.error()).toBeUndefined();
  });

  it('rejects EventSource event names', () => {
    expect(() => create(() => '/events', { event: 'error' })).toThrow(/EventSource event/);
  });

  it('passes withCredentials', () => {
    create(() => '/events', { withCredentials: true });
    expect(FakeEventSource.last.withCredentials).toBe(true);
  });
});

describe('sseResource reconnect with backoff', () => {
  beforeEach(() => {
    setup();
    vi.useFakeTimers();
  });

  it('waits initialDelayMs, then doubles the delay', () => {
    const res = create(() => '/events', { reconnect: { initialDelayMs: 100, maxDelayMs: 10_000 } });
    FakeEventSource.last.fail();
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(res.status()).toBe('reconnecting');
    expect(res.error()).toBeInstanceOf(SseConnectionError);

    vi.advanceTimersByTime(99);
    expect(FakeEventSource.instances.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances.length).toBe(2);
    expect(res.status()).toBe('reconnecting');

    FakeEventSource.last.fail();
    vi.advanceTimersByTime(199);
    expect(FakeEventSource.instances.length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances.length).toBe(3);

    FakeEventSource.last.fail();
    vi.advanceTimersByTime(399);
    expect(FakeEventSource.instances.length).toBe(3);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances.length).toBe(4);
  });

  it('never waits longer than maxDelayMs', () => {
    create(() => '/events', { reconnect: { initialDelayMs: 100, maxDelayMs: 300 } });
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = FakeEventSource.instances.length;
      FakeEventSource.last.fail();
      let waited = 0;
      while (FakeEventSource.instances.length === before) {
        vi.advanceTimersByTime(10);
        waited += 10;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([100, 200, 300, 300, 300, 300]);
  });

  it('resets the delay after a successful open', () => {
    const res = create(() => '/events', { reconnect: { initialDelayMs: 100 } });
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(100);
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(200);
    FakeEventSource.last.open();
    expect(res.status()).toBe('open');
    expect(res.error()).toBeUndefined();

    FakeEventSource.last.fail();
    vi.advanceTimersByTime(99);
    expect(FakeEventSource.instances.length).toBe(3);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances.length).toBe(4);
  });

  it('gives up after maxAttempts', () => {
    const res = create(() => '/events', { reconnect: { initialDelayMs: 100, maxAttempts: 2 } });
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(100);
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(200);
    FakeEventSource.last.fail();
    expect(res.status()).toBe('error');
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances.length).toBe(3);
  });

  it('closes the native source on error so the browser does not reconnect in parallel', () => {
    create(() => '/events');
    FakeEventSource.last.fail(0);
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  it('sends the last event id as a query parameter on reconnect', () => {
    create(() => '/events?job=7', { lastEventIdParam: 'lastEventId', reconnect: { initialDelayMs: 1 } });
    FakeEventSource.last.emit('1', 'message', '42');
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.last.url).toBe('/events?job=7&lastEventId=42');
  });

  it('does not reconnect when reconnect is false', () => {
    const res = create(() => '/events', { reconnect: false });
    FakeEventSource.last.fail();
    expect(res.status()).toBe('error');
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances.length).toBe(1);
  });

  it('close() cancels a pending reconnect', () => {
    const res = create(() => '/events', { reconnect: { initialDelayMs: 100 } });
    FakeEventSource.last.fail();
    res.close();
    expect(res.status()).toBe('closed');
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances.length).toBe(1);
  });
});

describe("sseResource reconnect: 'browser'", () => {
  beforeEach(() => setup());

  it('leaves reconnects to the browser, which honors the server retry: field', () => {
    const res = create(() => '/events', { reconnect: 'browser' });
    const es = FakeEventSource.last;
    es.open();
    es.fail(0);
    expect(res.status()).toBe('reconnecting');
    expect(es.closed).toBe(false);
    expect(FakeEventSource.instances.length).toBe(1);

    es.open();
    expect(res.status()).toBe('open');
    expect(res.error()).toBeUndefined();
  });

  it('reports an error when the browser gives up', () => {
    const res = create(() => '/events', { reconnect: 'browser' });
    FakeEventSource.last.fail(2);
    expect(res.status()).toBe('error');
    expect(FakeEventSource.instances.length).toBe(1);
  });
});

describe('sseResource url', () => {
  beforeEach(() => setup());

  it('switches the connection when the url changes', () => {
    const id = signal(1);
    const res = create<number>(() => `/jobs/${id()}/events`);
    const first = FakeEventSource.last;
    first.emit('5', 'message', 'a');

    id.set(2);
    TestBed.tick();
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances.length).toBe(2);
    expect(FakeEventSource.last.url).toBe('/jobs/2/events');
    expect(res.value()).toBeUndefined();
    expect(res.lastEventId()).toBeUndefined();

    first.emit('9');
    expect(res.value()).toBeUndefined();
  });

  it('does not reconnect when the url string stays the same', () => {
    const tick = signal(0);
    create(() => (tick() >= 0 ? '/events' : null));
    tick.set(1);
    TestBed.tick();
    expect(FakeEventSource.instances.length).toBe(1);
  });

  it('stays idle while the url is null and closes when it becomes null', () => {
    const url = signal<string | null>(null);
    const res = create(() => url());
    expect(res.status()).toBe('idle');
    expect(FakeEventSource.instances.length).toBe(0);

    url.set('/events');
    TestBed.tick();
    expect(res.status()).toBe('connecting');

    url.set(null);
    TestBed.tick();
    expect(FakeEventSource.last.closed).toBe(true);
    expect(res.status()).toBe('idle');
  });

  it('opens a new connection after close() when the url changes', () => {
    const id = signal(1);
    const res = create(() => `/jobs/${id()}`);
    res.close();
    expect(FakeEventSource.last.closed).toBe(true);
    expect(res.status()).toBe('closed');

    id.set(2);
    TestBed.tick();
    expect(FakeEventSource.instances.length).toBe(2);
    expect(res.status()).toBe('connecting');
  });
});

describe('sseResource until', () => {
  beforeEach(() => {
    setup();
    vi.useFakeTimers();
  });

  it('closes cleanly on the terminal event and does not reconnect', () => {
    const res = create<{ type: string }>(() => '/events', {
      event: ['progress', 'done'],
      parse: (data, event) => ({ type: event.type, ...JSON.parse(data) }),
      until: (v) => v.type === 'done',
    });
    const es = FakeEventSource.last;
    es.open();
    es.emit('{"p":50}', 'progress');
    expect(res.status()).toBe('open');
    es.emit('{}', 'done');
    expect(res.value()).toEqual({ type: 'done' });
    expect(res.status()).toBe('closed');
    expect(es.closed).toBe(true);

    es.fail(0);
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances.length).toBe(1);
    expect(res.status()).toBe('closed');
  });
});

describe('sseResource lifecycle', () => {
  it('closes the connection and pending timers when the injector is destroyed', () => {
    setup();
    vi.useFakeTimers();
    const child = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
    const res = sseResource(() => '/events', { injector: child, reconnect: { initialDelayMs: 100 } });
    TestBed.tick();
    FakeEventSource.last.open();

    child.destroy();
    expect(FakeEventSource.last.closed).toBe(true);
    expect(res.status()).toBe('closed');

    const pending = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
    sseResource(() => '/events', { injector: pending, reconnect: { initialDelayMs: 100 } });
    TestBed.tick();
    FakeEventSource.last.fail();
    pending.destroy();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances.length).toBe(2);
  });

  it('throws outside an injection context without an injector', () => {
    setup();
    expect(() => sseResource(() => '/events')).toThrow();
  });

  it('accepts an explicit injector', () => {
    setup();
    const res = sseResource(() => '/events', { injector: TestBed.inject(Injector) });
    TestBed.tick();
    expect(res.status()).toBe('connecting');
  });

  it('stays idle on the server', () => {
    setup([{ provide: PLATFORM_ID, useValue: 'server' }]);
    const res = create(() => '/events');
    expect(res.status()).toBe('idle');
    expect(FakeEventSource.instances.length).toBe(0);
    expect(() => res.close()).not.toThrow();
  });

  it('stays idle when there is no EventSource', () => {
    TestBed.configureTestingModule({ providers: [{ provide: SSE_EVENT_SOURCE, useValue: undefined }] });
    const res = create(() => '/events');
    expect(res.status()).toBe('idle');
  });
});

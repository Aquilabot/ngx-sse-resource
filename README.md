# ngx-sse-resource

[![CI](https://github.com/Aquilabot/ngx-sse-resource/actions/workflows/ci.yml/badge.svg)](https://github.com/Aquilabot/ngx-sse-resource/actions/workflows/ci.yml)

Server-Sent Events as Angular signals. `sseResource()` opens an `EventSource`,
puts the last event in a signal, reconnects with exponential backoff and closes
itself when the component or service is destroyed.

- One function, four signals, one `close()`. No RxJS in the public API
- Reactive url: change it and the old connection closes, a new one opens
- Named events, custom `parse`, and `until` to close on a terminal event
- Exponential backoff with a cap, reset after each successful open
- Zoneless and standalone. SSR safe: on the server it stays idle
- Replaceable `EventSource` through an `InjectionToken`, for tests and polyfills
- No dependencies besides Angular

Requires Angular 22. Not on npm yet. Build it and install the package from `dist`:

```
git clone https://github.com/Aquilabot/ngx-sse-resource && cd ngx-sse-resource
npm ci && npm run build
npm install /path/to/ngx-sse-resource/dist/ngx-sse-resource   # from your app
```

## Example

A progress bar for a long job, such as a Spring `SseEmitter` that sends
`progress` events and a final `done` event:

```ts
import { Component, computed, signal } from '@angular/core';
import { sseResource } from 'ngx-sse-resource';

type JobEvent = { type: 'progress'; percent: number } | { type: 'done'; downloadUrl: string };

@Component({
  selector: 'app-job',
  template: `
    <progress max="100" [value]="percent()"></progress>
    <p>{{ job.status() }}</p>
  `,
})
export class JobComponent {
  readonly jobId = signal<string | null>(null);

  readonly job = sseResource<JobEvent>(
    () => (this.jobId() ? `/api/jobs/${this.jobId()}/events` : null),
    {
      event: ['progress', 'done'],
      parse: (data, event) => ({ type: event.type, ...JSON.parse(data) }),
      until: (value) => value.type === 'done',
    },
  );

  readonly percent = computed(() => {
    const value = this.job.value();
    return value?.type === 'done' ? 100 : (value?.percent ?? 0);
  });
}
```

The simplest case is one line:

```ts
readonly price = sseResource<Price>(() => '/api/prices');   // unnamed events, JSON
```

Call `sseResource` in an injection context (a field initializer or a
constructor), or pass `{ injector }`.

## API

`sseResource<T>(url, options?)` returns an `SseResource<T>`.

`url` is a function. It runs in a reactive context, so it can read signals.
Return `null` or `undefined` for no connection.

| Option                     | Default      | What it does                                                                      |
| -------------------------- | ------------ | --------------------------------------------------------------------------------- |
| `event`                    | `'message'`  | Event name or array of names. `'message'` means events without an `event:` field. |
| `parse`                    | `JSON.parse` | `(data, event) => T`. Use `(data) => data` for plain text.                        |
| `until`                    | none         | `(value, event) => boolean`. When true, close the stream after setting the value. |
| `reconnect`                | `{}`         | Backoff options, `'browser'` or `false`. See below.                               |
| `reconnect.initialDelayMs` | `500`        | Delay before the first reconnect.                                                 |
| `reconnect.maxDelayMs`     | `10000`      | Cap for any delay.                                                                |
| `reconnect.factor`         | `2`          | Multiplier per failed attempt.                                                    |
| `reconnect.maxAttempts`    | `Infinity`   | Reconnect attempts in a row before giving up with status `'error'`.               |
| `withCredentials`          | `false`      | Passed to `EventSource`. Sends cookies to another origin.                         |
| `lastEventIdParam`         | none         | On a backoff reconnect, add the last event id to the url under this query name.   |
| `injector`                 | current      | Injector to use outside an injection context.                                     |

| Member        | Type                          | Meaning                                                 |
| ------------- | ----------------------------- | ------------------------------------------------------- |
| `value`       | `Signal<T \| undefined>`      | Last parsed value.                                      |
| `status`      | `Signal<SseStatus>`           | See the table below.                                    |
| `error`       | `Signal<unknown>`             | Last error. Cleared by the next value or the next open. |
| `lastEventId` | `Signal<string \| undefined>` | `id:` of the last event, if the server sends ids.       |
| `close()`     | `void`                        | Close the connection and cancel a pending reconnect.    |

| Status         | When                                                                  |
| -------------- | --------------------------------------------------------------------- |
| `idle`         | The url is `null`, or there is no `EventSource` (server, Node).       |
| `connecting`   | First connection for the current url.                                 |
| `open`         | Connected.                                                            |
| `reconnecting` | Lost the connection, waiting or trying again.                         |
| `closed`       | `close()` was called, `until` matched, or the injector was destroyed. |
| `error`        | Reconnect is off or gave up. `error()` holds the reason.              |

When the url changes, `value`, `error` and `lastEventId` reset. After
`close()` or `until`, a new url opens a new connection. The same url string
does not reconnect.

**Errors.** If `parse` throws, `error()` holds what it threw, `value()` keeps
the previous value and the stream stays open. The next good event clears
`error()`. A connection failure puts an `SseConnectionError` (with `url` and
the raw `event`) in `error()`. `EventSource` does not expose the HTTP status
or any detail, so neither can this library.

## Reconnect

`EventSource` reconnects by itself. It waits the time the server sent in
`retry:` (or about 3 seconds) and sends a `Last-Event-ID` header. It never
backs off, and JavaScript cannot read the `retry:` value or set that header.
So you pick one of three modes:

**Backoff (default).** On any error the library closes the `EventSource`
first, so the browser does not reconnect in parallel. Then it waits
`initialDelayMs`, doubling each time up to `maxDelayMs`, and opens a new one.
A successful open resets the delay. No jitter. In this mode the server's
`retry:` is ignored, and the browser does not send `Last-Event-ID` because
each connection is a new `EventSource`. To resume a stream, set
`lastEventIdParam: 'lastEventId'` and read that query parameter on the server.

**`reconnect: 'browser'`.** The library does nothing on a dropped connection
and shows `reconnecting` until the browser opens it again. The server's
`retry:` and the `Last-Event-ID` header work as the spec says. If the browser
gives up (a non-200 answer or a wrong content type), status becomes `error`.

**`reconnect: false`.** The first error ends the stream with status `error`.

**One-shot jobs.** A server that ends the stream after the last event looks
like a dropped connection to `EventSource`. If closing the connection cancels
the job, or a new connection starts a new job, use `until` so the stream
closes before any reconnect, or set `reconnect: false`.

Do not use `open` or `error` as server event names. They clash with
`EventSource`'s own events, so `sseResource` throws if you pass them.

## SSR

On the server `isPlatformServer` is true and there is no `EventSource`, so
the resource stays `idle`, opens nothing and does not throw. The connection
starts in the browser after hydration.

## Testing your components

The constructor comes from the `SSE_EVENT_SOURCE` token. Provide a fake in
`TestBed`:

```ts
TestBed.configureTestingModule({
  providers: [{ provide: SSE_EVENT_SOURCE, useValue: FakeEventSource }],
});
```

The fake needs `addEventListener`, `close()` and `readyState`. Extending
`EventTarget` is enough. The library's own spec has one you can copy. The
same token accepts an `EventSource` polyfill, for example one that can send
an `Authorization` header.

For RxJS, use `toObservable(resource.value)` from `@angular/core/rxjs-interop`.

## Demo

```
npm install
npm run demo        # builds the library and the demo, serves http://localhost:4300
```

`demo/server.mjs` is a zero-dependency Node server. It sends ten `progress`
events and a `done` event, and drops the first connection at 50%. The page
reconnects after 500 ms and resumes from the last event id.

## Numbers

Measured on 2026-10-24 with Angular 22.2.3, Vitest 5.0.5, Node 26.12.1.

```
npm test
 Test Files  1 passed (1)
      Tests  27 passed (27)
```

The tests use a fake `EventSource` and Vitest fake timers. They cover values,
named events, parse errors, backoff timing, the cap, reset after open,
browser mode, `lastEventIdParam`, url changes, `null` url, `close()`,
`until`, injector destruction and SSR.

```
npm run build
wc -c dist/ngx-sse-resource/fesm2022/ngx-sse-resource.mjs           # 4770 bytes
gzip -9 -c dist/ngx-sse-resource/fesm2022/ngx-sse-resource.mjs | wc -c   # 1700 bytes
```

Minified with esbuild and gzipped it is 1290 bytes. That is roughly what it
adds to an app bundle.

## Limitations

- GET only, no custom headers. That is how `EventSource` works. Use cookies
  with `withCredentials`, a token in the url, or a polyfill through
  `SSE_EVENT_SOURCE`.
- `value()` holds the last event only. To keep a history, collect values in
  an `effect` or in `parse`.
- In the default mode the server's `retry:` value is not used (see Reconnect).
- No jitter in the backoff. Many clients that drop at the same moment
  reconnect at the same moments.
- Over HTTP/1.1 browsers allow about six connections per origin, and each open
  stream holds one. HTTP/2 does not have this limit.
- One resource is one connection. Two resources with the same url open two
  connections.

## License

MIT. See [LICENSE](LICENSE).

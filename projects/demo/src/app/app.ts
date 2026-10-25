import { Component, computed, signal } from '@angular/core';
import { sseResource } from 'ngx-sse-resource';

type JobEvent = { type: 'progress'; percent: number } | { type: 'done'; elapsedMs: number };

@Component({
  selector: 'app-root',
  template: `
    <h1>ngx-sse-resource demo</h1>
    <p>
      The server sends ten <code>progress</code> events and one <code>done</code> event. It drops
      the first connection at 50% to show a reconnect that resumes from the last event id.
    </p>
    <button type="button" (click)="start()" [disabled]="running()">Start job</button>
    <p>
      <progress max="100" [value]="percent()"></progress>
      {{ percent() }}%
    </p>
    <p>Status: <strong>{{ job.status() }}</strong></p>
    <p>Last event id: {{ job.lastEventId() ?? '-' }}</p>
    @if (job.value(); as v) {
      @if (v.type === 'done') {
        <p>Done in {{ v.elapsedMs }} ms.</p>
      }
    }
  `,
})
export class App {
  private readonly jobId = signal<number | null>(null);

  protected readonly job = sseResource<JobEvent>(
    () => {
      const id = this.jobId();
      return id === null ? null : `/api/jobs/${id}/events`;
    },
    {
      event: ['progress', 'done'],
      parse: (data, event) => ({ type: event.type, ...JSON.parse(data) }),
      until: (value) => value.type === 'done',
      lastEventIdParam: 'lastEventId',
      reconnect: { initialDelayMs: 500, maxDelayMs: 5_000 },
    },
  );

  protected readonly percent = computed(() => {
    const value = this.job.value();
    return value?.type === 'done' ? 100 : (value?.percent ?? 0);
  });

  protected readonly running = computed(() =>
    ['connecting', 'open', 'reconnecting'].includes(this.job.status()),
  );

  protected start(): void {
    this.jobId.set(Date.now());
  }
}

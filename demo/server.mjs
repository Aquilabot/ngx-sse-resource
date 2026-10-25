// Zero-dependency demo server: serves the built demo app and an SSE endpoint.
// Run with `npm run demo`, then open http://localhost:4300.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = Number(process.env.PORT ?? 4300);
const root = join(import.meta.dirname, '..', 'dist', 'demo', 'browser');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon' };
const dropped = new Set();
const started = new Map();

function streamJob(req, res, jobId, url) {
  const resumeFrom = Number(url.searchParams.get('lastEventId') ?? req.headers['last-event-id'] ?? 0);
  if (!started.has(jobId)) started.set(jobId, Date.now());
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write('retry: 2000\n\n');

  let step = resumeFrom;
  const timer = setInterval(() => {
    step++;
    if (step <= 10) {
      const event = `event: progress\nid: ${step}\ndata: ${JSON.stringify({ percent: step * 10 })}\n\n`;
      if (step === 5 && !dropped.has(jobId)) {
        dropped.add(jobId);
        clearInterval(timer);
        res.write(event, () => res.destroy());
        return;
      }
      res.write(event);
      return;
    }
    const elapsedMs = Date.now() - started.get(jobId);
    res.write(`event: done\nid: ${step}\ndata: ${JSON.stringify({ elapsedMs })}\n\n`);
    clearInterval(timer);
    res.end();
  }, 400);
  req.on('close', () => clearInterval(timer));
}

async function serveFile(res, pathname) {
  const file = normalize(join(root, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const match = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/events$/);
  if (match) return streamJob(req, res, match[1], url);
  return serveFile(res, url.pathname);
}).listen(port, () => console.log(`demo on http://localhost:${port}`));

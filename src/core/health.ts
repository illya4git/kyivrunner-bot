import { createServer, type Server } from 'node:http';

export type HealthReport = { ok: boolean; [k: string]: unknown };

/**
 * Tiny HTTP endpoint for the container healthcheck: GET /healthz → 200 if healthy, else 503.
 * Bound to localhost only; it is not meant to be published outside the container.
 */
export function startHealthServer(port: number, check: () => HealthReport): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    let report: HealthReport;
    try {
      report = check();
    } catch (err) {
      report = { ok: false, error: String(err) };
    }
    res.writeHead(report.ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(report));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

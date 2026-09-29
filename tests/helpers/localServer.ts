import http from 'node:http';

/**
 * Listen on 127.0.0.1 for supertest. Never hand supertest a bare app: it then listens on
 * port 0 of the dual-stack wildcard (`::`) and dials 127.0.0.1:<port>. macOS can hand out a
 * wildcard port another process already holds on 127.0.0.1, and the request then lands on
 * that process instead (a random 404/400, or no answer at all, which times the test out
 * and leaves the listener open so mocha never exits). Binding 127.0.0.1 explicitly makes the
 * kernel refuse such a port. Found in bridge-tempdrop (B-2026-09-25-1).
 *
 * The server and every accepted socket are unref'd so the listener never holds mocha open.
 */
export async function listenLocal (app: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(app);
  server.on('connection', (socket) => socket.unref());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  return server;
}

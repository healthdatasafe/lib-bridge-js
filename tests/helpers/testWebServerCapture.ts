import boiler from 'dev-boiler';
import http from 'http';
import querystring from 'node:querystring';

let logger: ReturnType<typeof boiler.getLogger> | null = null;
function getLoggerLazy () {
  if (logger == null) logger = boiler.getLogger('testServer');
  return logger;
}

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  path?: string;
  query?: Record<string, unknown>;
  body?: string;
}

interface MockResponse {
  code: number;
  headers: Record<string, string>;
  body: string;
}

interface HttpServerCapture {
  captured: CapturedRequest[];
  nextCalls: MockResponse[];
  close: () => Promise<void>;
}

/**
 * Launch a small web server to capture eventual external calls
 * See test-suite [TESX] to see how it works.
 */
async function startHttpServerCapture (params?: { port?: number }): Promise<HttpServerCapture> {
  const captured: CapturedRequest[] = [];
  const nextCalls: MockResponse[] = [];
  const port = params?.port || 8365;
  const host = '127.0.0.1';
  const server = http.createServer(onRequest);
  await new Promise<void>((resolve) => { server.listen(port, host, resolve); });
  getLoggerLazy().info('Started webServerCapture on port: ' + port);

  async function close (): Promise<void> {
    return new Promise((resolve) => {
      server.close(() => {
        resolve();
        getLoggerLazy().info('Stopped webServerCapture on port: ' + port);
      }
      );
      // Closes all connections, ensuring the server closes successfully
      server.closeAllConnections();
    });
  }

  async function onRequest (req: http.IncomingMessage, res: http.ServerResponse) {
    getLoggerLazy().info('WebServerCapture request: ' + req.url);
    try {
      const result: CapturedRequest = {
        method: req.method!,
        url: req.url!,
        headers: req.headers
      };
      const indexOfQuestionMark = req.url!.indexOf('?');
      if (indexOfQuestionMark > -1) {
        result.path = req.url!.substring(0, indexOfQuestionMark);
        const queryPart = req.url!.substring(indexOfQuestionMark + 1);
        result.query = querystring.parse(queryPart) as Record<string, unknown>;
      } else {
        result.path = req.url;
        result.query = {};
      }
      // capture content
      if (req.method === 'POST') {
        const body: Buffer[] = [];
        req
          .on('data', (chunk: Buffer) => { body.push(chunk); })
          .on('end', () => {
            result.body = Buffer.concat(body).toString();
            captured.push(result);
          });
      } else {
        captured.push(result);
      }

      // handle response
      const response = nextCalls.pop() || {
        code: 200,
        headers: { },
        body: 'OK'
      };
      res.writeHead(response.code, response.headers);
      res.write(response.body);
      res.end();
    } catch (e) {
      getLoggerLazy().error(String(e));
    }
    getLoggerLazy().info('WebServerCapture sent ');
  }

  return { captured, nextCalls, close };
}

export { startHttpServerCapture };

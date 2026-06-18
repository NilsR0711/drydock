// Minimal stand-in for the standalone server, used by the daemon lifecycle
// integration test (issue #216). It speaks just enough of the real contract to
// exercise start/stop/status across every OS without building the full Next
// app: a plain HTTP server that stays alive until the control endpoint asks it
// to drain. Mirrors src/app/api/control/shutdown/route.ts.

import { createServer } from "node:http";

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const host = flag("--host", "127.0.0.1");
const port = Number(flag("--port", "0"));
const token = process.env.DRYDOCK_CONTROL_TOKEN;

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/control/shutdown") {
    if (token && req.headers["x-drydock-control-token"] === token) {
      res.writeHead(202).end("draining");
      // Exit after the response flushes, like the real graceful shutdown.
      setTimeout(() => process.exit(0), 10).unref();
      return;
    }
    res.writeHead(403).end("forbidden");
    return;
  }
  res.writeHead(200).end("alive");
});

server.listen(port, host);

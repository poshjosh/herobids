#!/usr/bin/env python3
# Fake Nomad HTTP API for test-capacity-observer.sh. Binds 127.0.0.1 only.
# Usage: fake-nomad-observer.py PORT REQUEST_LOG BLOCKED_COUNT
# Appends every request path (with query) to REQUEST_LOG, then serves a leader
# status and BLOCKED_COUNT resource-blocked evaluations created "now".
import http.server
import json
import sys
import time

PORT = int(sys.argv[1])
REQUEST_LOG = sys.argv[2]
BLOCKED_COUNT = int(sys.argv[3])


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        with open(REQUEST_LOG, "a") as fh:
            fh.write(self.path + "\n")
        if self.path.startswith("/v1/status/leader"):
            self._send("127.0.0.1:4647")
            return
        if self.path.startswith("/v1/evaluations"):
            now_ns = time.time_ns()
            evals = []
            for i in range(BLOCKED_COUNT):
                evals.append({
                    "ID": "eval-%d" % i,
                    "JobID": "job-%d" % i,
                    "Status": "blocked",
                    "CreateTime": now_ns,
                    "BlockedEval": "resources exhausted: memory",
                })
            self._send(evals)
            return
        self.send_response(404)
        self.end_headers()


class Server(http.server.HTTPServer):
    allow_reuse_address = True


Server(("127.0.0.1", PORT), Handler).serve_forever()

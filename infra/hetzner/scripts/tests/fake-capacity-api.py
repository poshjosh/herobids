#!/usr/bin/env python3
# Fake Hetzner + Nomad HTTP API for test-capacity-scale-out-demand.sh. Binds 127.0.0.1 only.
# Usage: fake-capacity-api.py PORT FIXTURE_DIR REQUEST_LOG ENVIRONMENT
# Serves GET /v1/servers (Hetzner body wrapped from cloud-healthy.json, with the
# environment label set to ENVIRONMENT because scale-out accepts only staging or
# production), GET /v1/nodes (nomad-healthy.json) and GET /v1/evaluations (empty, so no
# demand). Every request path is appended to REQUEST_LOG. Synthetic fixtures; no real
# provider or cluster is contacted.
import http.server
import json
import os
import sys

PORT = int(sys.argv[1])
FIXTURE_DIR = sys.argv[2]
REQUEST_LOG = sys.argv[3]
ENVIRONMENT = sys.argv[4]


def load(name):
    with open(os.path.join(FIXTURE_DIR, name)) as fh:
        return json.load(fh)


def cloud_servers():
    servers = load("cloud-healthy.json")
    for server in servers:
        server.setdefault("labels", {})["environment"] = ENVIRONMENT
    return servers


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
        if self.path.startswith("/v1/servers"):
            self._send({"servers": cloud_servers(),
                        "meta": {"pagination": {"next_page": None}}})
            return
        if self.path.startswith("/v1/nodes"):
            self._send(load("nomad-healthy.json"))
            return
        if self.path.startswith("/v1/evaluations"):
            self._send([])
            return
        self.send_response(404)
        self.end_headers()


class Server(http.server.HTTPServer):
    allow_reuse_address = True


Server(("127.0.0.1", PORT), Handler).serve_forever()

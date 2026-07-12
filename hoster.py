#!/usr/bin/env python3
"""Static file hoster for the fdiff web build (sliftutils bundler output)."""
import http.server
import socketserver
import os

PORT = int(os.environ.get("FDIFF_PORT", "8080"))
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "build-web")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        # Serve the built index at the site root.
        if self.path in ("/", "/index.html"):
            self.path = "/web/index.html"
        return super().do_GET()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        print(f"Serving {ROOT} on http://0.0.0.0:{PORT}")
        httpd.serve_forever()

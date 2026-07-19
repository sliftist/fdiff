#!/usr/bin/env python3
"""Static file hoster for the fdiff web build (sliftutils bundler output).

Cloudflare terminates HTTPS in front of this and proxies plain HTTP to PORT. Cloudflare only
caches (and stamps its own Browser Cache TTL) when the origin stays silent about caching, so this
server sets Cache-Control explicitly on every response — otherwise the edge invents a multi-hour
TTL and redeploys go stale. index.html is never cached; browser.js has a stable (non-fingerprinted)
name, so it is revalidated rather than cached immutably, letting every redeploy show up immediately.
"""
import http.server
import socketserver
import os

PORT = int(os.environ.get("FDIFF_PORT", "8080"))
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "build-web")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        # Strip the query string (and fragment) before matching — the app carries its state in
        # ?path=..., so "/?path=D:\repos\foo" must still serve the SPA entry document, not a listing.
        route = self.path.split("?", 1)[0].split("#", 1)[0]
        if route in ("/", "/index.html"):
            self.path = "/web/index.html"
        return super().do_GET()

    def end_headers(self):
        path = self.path.split("?", 1)[0]
        if path.endswith("/") or path.endswith("index.html") or path == "":
            # Always re-fetch the entry document so a redeploy is picked up on the next load.
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        elif path.endswith(".js") or path.endswith(".wasm"):
            # Stable filename (no fingerprint), so revalidate every time. Python answers
            # If-Modified-Since with 304 when unchanged, so this stays cheap despite the size.
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        # Basic security headers: no framing by other origins (clickjacking), and only send the
        # origin as referrer cross-origin. Feature permissions are left to the application.
        # frame-ancestors is the modern X-Frame-Options; it's the ONLY CSP directive here — content
        # directives (script-src etc.) would constrain the app, so they stay the app's business.
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Content-Security-Policy", "frame-ancestors 'self'")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        print(f"Serving {ROOT} on http://0.0.0.0:{PORT}")
        httpd.serve_forever()

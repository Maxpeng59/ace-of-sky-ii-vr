#!/usr/bin/env python3
# Ace of Sky II — dev server. Caching disabled so code changes always reach the browser.
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    port = int(os.environ.get('PORT', sys.argv[1] if len(sys.argv) > 1 else 8127))
    try:
        server = http.server.ThreadingHTTPServer(('', port), NoCacheHandler)
    except OSError as e:
        print(f'\n  Could not bind port {port}: {e}')
        print(f'  Stop the other process:  kill $(lsof -tiTCP:{port} -sTCP:LISTEN)\n')
        sys.exit(1)
    print(
        f'\n  ACE OF SKY II  ·  dev server (caching disabled)'
        f'\n  ->  http://localhost:{port}'
        f'\n  Ctrl+C to stop.\n', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  server stopped\n')

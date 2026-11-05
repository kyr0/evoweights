#!/usr/bin/env python3
"""Serve the included built site with cross-origin isolation; no dependencies."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--host', default='127.0.0.1')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1] / 'docs'
    if not (root / 'index.html').is_file():
        parser.error('Missing docs/index.html. Run make build or use the complete release ZIP.')
    with ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=str(root))) as server:
        print(f'HuggingDOOM: http://{args.host}:{args.port}/#arena', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass

if __name__ == '__main__':
    main()

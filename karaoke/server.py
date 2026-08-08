#!/usr/bin/env python3
"""Static file server for the karaoke app, with a same-origin /api/search
route that proxies the YouTube lookup through Piped server-side.

Public Piped mirrors frequently don't send Access-Control-Allow-Origin
headers, which blocks direct browser fetches. Server-to-server requests
aren't subject to CORS, so doing the lookup here sidesteps the problem
entirely. Run with: python3 server.py [port]
"""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PIPED_INSTANCE_LIST_URL = 'https://piped-instances.kavin.rocks/'
FALLBACK_PIPED_INSTANCES = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://pipedapi.in.projectsegfau.lt',
]
REQUEST_TIMEOUT = 8


def fetch_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'karaoke-app/1.0'})
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        return json.loads(resp.read())


def get_piped_instances():
    try:
        data = fetch_json(PIPED_INSTANCE_LIST_URL)
        urls = [inst['api_url'] for inst in data if inst.get('api_url')]
        if urls:
            return urls
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as e:
        print(f'Could not fetch live Piped instance list, using fallback: {e}')
    return FALLBACK_PIPED_INSTANCES


def search_youtube(query):
    for instance in get_piped_instances():
        try:
            url = f'{instance}/search?q={urllib.parse.quote(query)}&filter=videos'
            data = fetch_json(url)
            for item in data.get('items', []):
                if item.get('type') == 'stream' and item.get('url'):
                    return item['url']
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            print(f'Piped instance {instance} failed: {e}')
            continue
    return None


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/search':
            self.handle_search(parsed.query)
            return
        super().do_GET()

    def handle_search(self, query_string):
        params = urllib.parse.parse_qs(query_string)
        query = params.get('q', [''])[0]
        if not query:
            self.send_error(400, 'Missing q parameter')
            return

        video_url = search_youtube(query)
        body = json.dumps({'url': video_url}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(('', port), Handler)
    print(f'Serving karaoke app on http://localhost:{port}')
    server.serve_forever()

#!/usr/bin/env python3
"""Static file server for the karaoke app, with a same-origin /api/search
route that proxies the YouTube lookup through Piped server-side, and
optionally auto-detects the lyric sync offset from the matched video's
captions.

Public Piped mirrors frequently don't send Access-Control-Allow-Origin
headers, which blocks direct browser fetches. Server-to-server requests
aren't subject to CORS, so doing the lookup here sidesteps the problem
entirely. Run with: python3 server.py [port]
"""
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PIPED_INSTANCE_LIST_URL = 'https://piped-instances.kavin.rocks/'
FALLBACK_PIPED_INSTANCES = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://pipedapi.in.projectsegfau.lt',
]
REQUEST_TIMEOUT = 8
# Caption auto-sync is a nice-to-have on top of search, so it gets a smaller
# timeout — it must never make the user wait meaningfully longer for the
# video to actually start playing.
CAPTIONS_REQUEST_TIMEOUT = 4
# A generic User-Agent gets an empty response from YouTube's timedtext
# endpoint (likely bot filtering); a realistic browser one does not.
USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
# These external services (Piped mirrors, YouTube's timedtext endpoint)
# occasionally return something other-than-expected — null instead of a
# list, a dict missing a key, HTML instead of JSON, etc. None of that
# should ever be able to crash the request handler, so every external
# call is wrapped in this broad-but-specific set rather than a narrow one
# that a new shape of garbage response could slip past.
EXTERNAL_API_ERRORS = (
    urllib.error.URLError, TimeoutError, ValueError, KeyError,
    TypeError, AttributeError, IndexError, ET.ParseError,
)
VIDEO_ID_RE = re.compile(r'[?&]v=([a-zA-Z0-9_-]{11})')
WORD_RE = re.compile(r"[a-z0-9']+")
# Matches WebVTT/SRT cue timestamp lines, with or without an hours component,
# and with either '.' or ',' as the decimal separator.
TIMESTAMP_RE = re.compile(
    r'(?:(\d{2}):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}'
)


def fetch_json(url, timeout=REQUEST_TIMEOUT):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def fetch_text(url, timeout=REQUEST_TIMEOUT):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8', errors='replace')


def get_piped_instances():
    try:
        data = fetch_json(PIPED_INSTANCE_LIST_URL)
        urls = [inst['api_url'] for inst in data if inst.get('api_url')]
        if urls:
            return urls
    except EXTERNAL_API_ERRORS as e:
        print(f'Could not fetch live Piped instance list, using fallback: {e}')
    return FALLBACK_PIPED_INSTANCES


def find_video(instances, query):
    """Search Piped instances for a matching video.

    Returns (video_url, video_id), either of which may be None.
    """
    for instance in instances:
        try:
            url = f'{instance}/search?q={urllib.parse.quote(query)}&filter=videos'
            data = fetch_json(url)
            for item in data.get('items', []):
                if item.get('type') != 'stream' or not item.get('url'):
                    continue
                match = VIDEO_ID_RE.search(item['url'])
                if match:
                    return item['url'], match.group(1)
        except EXTERNAL_API_ERRORS as e:
            print(f'Piped instance {instance} failed to search: {e}')
            continue
    return None, None


def parse_webvtt(text):
    """Parse WebVTT/SRT-style caption text into [{'time': seconds, 'text': str}]."""
    cues = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        match = TIMESTAMP_RE.search(lines[i])
        if match:
            hours, minutes, seconds, millis = match.groups()
            start = (int(hours) if hours else 0) * 3600 + int(minutes) * 60 + int(seconds) + int(millis) / 1000
            i += 1
            text_lines = []
            while i < len(lines) and lines[i].strip():
                text_lines.append(re.sub(r'<[^>]+>', '', lines[i]).strip())
                i += 1
            cue_text = ' '.join(t for t in text_lines if t)
            if cue_text:
                cues.append({'time': start, 'text': cue_text})
        else:
            i += 1
    return cues


def normalize_words(text):
    return set(WORD_RE.findall(text.lower()))


def find_caption_offset(cues, first_line_text, first_line_time):
    """Find the first caption cue that shares words with the first lyric
    line, and return the offset needed to align them, or None."""
    target_words = normalize_words(first_line_text)
    if not target_words:
        return None
    required_overlap = 2 if len(target_words) >= 2 else 1

    for cue in cues:
        overlap = target_words & normalize_words(cue['text'])
        if len(overlap) >= required_overlap:
            return first_line_time - cue['time']
    return None


def get_youtube_caption_cues(video_id):
    """Fetch caption cues straight from YouTube's own timedtext endpoint —
    the same lightweight, key-less endpoint the regular web player uses to
    show captions — instead of going through a third-party Piped mirror.

    Piped's /streams endpoint proxies YouTube's *stream extraction*, which
    is what YouTube's anti-scraping measures target hardest and which kept
    500ing on every available mirror. Captions don't need any of that: no
    signature deciphering, no auth. Returns (cues, error_message).
    """
    try:
        list_xml = fetch_text(
            f'https://www.youtube.com/api/timedtext?type=list&v={video_id}',
            timeout=CAPTIONS_REQUEST_TIMEOUT,
        )
        if not list_xml.strip():
            return None, 'caption list request returned an empty response (likely bot-filtered or blocked)'
        tracks = ET.fromstring(list_xml).findall('track')
        if not tracks:
            return None, 'video has no caption tracks'

        track = next((t for t in tracks if (t.get('lang_code') or '').startswith('en')), tracks[0])
        params = {'v': video_id, 'lang': track.get('lang_code', ''), 'fmt': 'vtt'}
        if track.get('kind'):
            params['kind'] = track.get('kind')

        vtt_text = fetch_text(
            'https://www.youtube.com/api/timedtext?' + urllib.parse.urlencode(params),
            timeout=CAPTIONS_REQUEST_TIMEOUT,
        )
        cues = parse_webvtt(vtt_text)
        if not cues:
            return None, 'caption track was empty'
        return cues, None
    except EXTERNAL_API_ERRORS as e:
        return None, str(e)


def get_suggested_offset(video_id, first_line_text, first_line_time):
    cues, error = get_youtube_caption_cues(video_id)
    if error:
        print(f'Caption auto-sync: {error}')
        return None

    offset = find_caption_offset(cues, first_line_text, first_line_time)
    if offset is not None:
        print(f'Caption auto-sync: matched cue, offset={offset:.2f}s')
    else:
        print(f'Caption auto-sync: got {len(cues)} caption cue(s), none matched the first lyric line')
    return offset


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

        # No matter what unexpected thing an external service throws at us,
        # this endpoint must always respond — a crash here means the browser
        # gets no HTTP response at all (ERR_EMPTY_RESPONSE) and the video
        # never loads, which is worse than just reporting "not found".
        video_url = video_id = None
        suggested_offset = None
        try:
            video_url, video_id = find_video(get_piped_instances(), query)

            first_line = params.get('first_line', [''])[0]
            first_line_time = params.get('first_line_time', [''])[0]
            if video_url and first_line and first_line_time:
                suggested_offset = get_suggested_offset(video_id, first_line, float(first_line_time))
        except (*EXTERNAL_API_ERRORS, ValueError) as e:
            print(f'/api/search failed unexpectedly, returning empty result: {e}')

        body = json.dumps({'url': video_url, 'suggestedOffset': suggested_offset}).encode()
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

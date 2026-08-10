#!/usr/bin/env python3
"""Static file server for the karaoke app, with a same-origin /api/search
route that proxies the YouTube lookup through Piped server-side, and
optionally auto-detects the lyric sync offset from the matched video's
captions.

Public Piped mirrors frequently don't send Access-Control-Allow-Origin
headers, which blocks direct browser fetches. Server-to-server requests
aren't subject to CORS, so doing the lookup here sidesteps the problem
entirely.

Caption auto-sync requires the youtube-transcript-api package:
    pip install youtube-transcript-api
It degrades to no-offset (manual tap-to-sync) if that's not installed
or the lookup fails for any reason — search itself doesn't need it.

Run with: python3 server.py [port]
"""
import concurrent.futures
import json
import re
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
# Caption auto-sync is a nice-to-have on top of search, so it gets its own
# wall-clock budget — it must never make the user wait meaningfully longer
# for the video to actually start playing, no matter how the underlying
# library behaves.
CAPTIONS_TIMEOUT = 10
USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
# These external services (Piped mirrors, the transcript library) occasionally
# return something other-than-expected — null instead of a list, a dict
# missing a key, etc. None of that should ever be able to crash the request
# handler, so every external call is wrapped in this broad-but-specific set
# rather than a narrow one that a new shape of garbage response could slip
# past.
EXTERNAL_API_ERRORS = (
    urllib.error.URLError, TimeoutError, ValueError, KeyError,
    TypeError, AttributeError, IndexError,
)
VIDEO_ID_RE = re.compile(r'[?&]v=([a-zA-Z0-9_-]{11})')
WORD_RE = re.compile(r"[a-z0-9']+")


def fetch_json(url, timeout=REQUEST_TIMEOUT):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


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


def _fetch_transcript_cues(video_id):
    """Runs in a worker thread — see get_youtube_caption_cues for the
    timeout wrapper. Only used for timing/word-overlap matching against
    the already-licensed lyrics text from LRCLIB; the transcript text
    itself is never shown to the user."""
    from youtube_transcript_api import YouTubeTranscriptApi

    try:
        # Newer versions of the library are instance-based.
        fetched = YouTubeTranscriptApi().fetch(video_id, languages=['en', 'en-US', 'en-GB'])
        return [{'time': s.start, 'text': s.text} for s in fetched]
    except AttributeError:
        # Older versions only expose the static method.
        raw = YouTubeTranscriptApi.get_transcript(video_id, languages=['en', 'en-US', 'en-GB'])
        return [{'time': item['start'], 'text': item['text']} for item in raw]


def get_youtube_caption_cues(video_id):
    """Fetch caption cue timing via the youtube-transcript-api library,
    which wraps YouTube's internal player API rather than the plain
    timedtext endpoint we used to hit directly — that got reliably
    empty-response'd, likely by bot filtering that a User-Agent/Referer
    alone couldn't get past. Returns (cues, error_message).
    """
    try:
        import youtube_transcript_api  # noqa: F401 (import-availability check)
    except ImportError:
        return None, 'youtube-transcript-api not installed — run: pip install youtube-transcript-api'

    # The library manages its own HTTP calls internally with no timeout
    # exposed, so bound it ourselves — this is a best-effort feature that
    # must never be able to stall the video from loading.
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    future = pool.submit(_fetch_transcript_cues, video_id)
    try:
        cues = future.result(timeout=CAPTIONS_TIMEOUT)
    except concurrent.futures.TimeoutError:
        return None, f'timed out after {CAPTIONS_TIMEOUT}s'
    except Exception as e:  # noqa: BLE001 - the library's own exception
        # hierarchy (TranscriptsDisabled, NoTranscriptFound, etc.) isn't
        # worth hard-coding; any failure here must degrade gracefully.
        return None, f'{type(e).__name__}: {e}'
    finally:
        pool.shutdown(wait=False)

    if not cues:
        return None, 'transcript was empty'
    return cues, None


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

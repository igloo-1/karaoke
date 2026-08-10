#!/usr/bin/env python3
"""Static file server for the karaoke app.

/api/search  finds a matching YouTube video for a text query.
/api/captions returns that video's raw caption cue timing (start/end/text)
             so the client can align each lyric line to its own best-
             matching cue, rather than a single global offset.

Both talk to YouTube directly through maintained libraries rather than
third-party Piped mirrors, which failed in nearly every way possible
during development: dead instances, CORS blocks, 500s, empty instance
lists, DNS failures. Requires:
    pip install -r requirements.txt

Run with: python3 server.py [port]
"""
import concurrent.futures
import json
import sys
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# yt-dlp/youtube-transcript-api manage their own HTTP internally with no
# timeout knob exposed, so every call to them is bounded with one of these
# via a worker thread — neither must ever be able to stall the video from
# loading, no matter how the library or YouTube's response behaves.
SEARCH_TIMEOUT = 15
CAPTIONS_TIMEOUT = 10
# A catch-all for whatever unexpected shape of error these external
# libraries or a malformed request might raise — none of it should ever be
# able to crash the request handler and leave the browser with no response.
EXTERNAL_API_ERRORS = (TimeoutError, ValueError, KeyError, TypeError, AttributeError, IndexError)


def _yt_dlp_search(query):
    """Runs in a worker thread — see find_video for the timeout wrapper."""
    import yt_dlp

    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        'extract_flat': True,
        'noplaylist': True,
        'socket_timeout': SEARCH_TIMEOUT,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(f'ytsearch1:{query}', download=False)

    entries = (info or {}).get('entries') or []
    if not entries:
        return None, None
    video_id = entries[0].get('id')
    if not video_id:
        return None, None
    return f'https://www.youtube.com/watch?v={video_id}', video_id


def find_video(query):
    """Search YouTube directly via yt-dlp. Returns (video_url, video_id),
    either of which may be None."""
    try:
        import yt_dlp  # noqa: F401 (import-availability check)
    except ImportError:
        print('yt-dlp not installed — run: pip install -r requirements.txt')
        return None, None

    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    future = pool.submit(_yt_dlp_search, query)
    try:
        return future.result(timeout=SEARCH_TIMEOUT)
    except concurrent.futures.TimeoutError:
        print(f'yt-dlp search timed out after {SEARCH_TIMEOUT}s')
        return None, None
    except Exception as e:  # noqa: BLE001 - yt-dlp's own exception hierarchy
        # isn't worth hard-coding; any failure here must degrade gracefully.
        print(f'yt-dlp search failed: {type(e).__name__}: {e}')
        return None, None
    finally:
        pool.shutdown(wait=False)


def _fetch_transcript_cues(video_id):
    """Runs in a worker thread — see get_youtube_caption_cues for the
    timeout wrapper. Cue timing is used client-side to align each lyric
    line to its own best-matching cue; the transcript text itself is
    never shown to the user — displayed lyrics come from LRCLIB."""
    from youtube_transcript_api import YouTubeTranscriptApi

    try:
        # Newer versions of the library are instance-based.
        fetched = YouTubeTranscriptApi().fetch(video_id, languages=['en', 'en-US', 'en-GB'])
        return [{'start': s.start, 'end': s.start + s.duration, 'text': s.text} for s in fetched]
    except AttributeError:
        # Older versions only expose the static method.
        raw = YouTubeTranscriptApi.get_transcript(video_id, languages=['en', 'en-US', 'en-GB'])
        return [{'start': item['start'], 'end': item['start'] + item['duration'], 'text': item['text']}
                for item in raw]


def get_youtube_caption_cues(video_id):
    """Fetch caption cue timing via the youtube-transcript-api library.
    Returns (cues, error_message)."""
    try:
        import youtube_transcript_api  # noqa: F401 (import-availability check)
    except ImportError:
        return None, 'youtube-transcript-api not installed — run: pip install -r requirements.txt'

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


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/search':
            self.handle_search(parsed.query)
            return
        if parsed.path == '/api/captions':
            self.handle_captions(parsed.query)
            return
        super().do_GET()

    def handle_search(self, query_string):
        params = urllib.parse.parse_qs(query_string)
        query = params.get('q', [''])[0]
        if not query:
            self.send_error(400, 'Missing q parameter')
            return

        # No matter what unexpected thing yt-dlp throws at us, this endpoint
        # must always respond — a crash here means the browser gets no HTTP
        # response at all (ERR_EMPTY_RESPONSE) and the video never loads.
        video_url = None
        try:
            video_url, _ = find_video(query)
        except EXTERNAL_API_ERRORS as e:
            print(f'/api/search failed unexpectedly, returning empty result: {e}')

        self._send_json({'url': video_url})

    def handle_captions(self, query_string):
        params = urllib.parse.parse_qs(query_string)
        video_id = params.get('v', [''])[0]
        if not video_id:
            self.send_error(400, 'Missing v parameter')
            return

        cues = None
        error = None
        try:
            cues, error = get_youtube_caption_cues(video_id)
        except EXTERNAL_API_ERRORS as e:
            error = f'{type(e).__name__}: {e}'
            print(f'/api/captions failed unexpectedly: {error}')

        self._send_json({'cues': cues, 'error': error})

    def _send_json(self, data):
        body = json.dumps(data).encode()
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

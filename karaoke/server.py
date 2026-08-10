#!/usr/bin/env python3
"""Static file server for the karaoke app, with a same-origin /api/search
route that finds a matching YouTube video and optionally auto-detects the
lyric sync offset from that video's captions.

Both steps talk to YouTube directly through maintained libraries rather
than third-party Piped mirrors, which failed in nearly every way possible
during development: dead instances, CORS blocks, 500s, empty instance
lists, DNS failures. Requires:
    pip install -r requirements.txt

Run with: python3 server.py [port]
"""
import concurrent.futures
import json
import re
import sys
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# yt-dlp/youtube-transcript-api manage their own HTTP internally with no
# timeout knob exposed, so every call to them is bounded with one of these
# via a worker thread — neither must ever be able to stall the video from
# loading, no matter how the library or YouTube's response behaves.
SEARCH_TIMEOUT = 15
CAPTIONS_TIMEOUT = 10
WORD_RE = re.compile(r"[a-z0-9']+")
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

        # No matter what unexpected thing an external library throws at us,
        # this endpoint must always respond — a crash here means the browser
        # gets no HTTP response at all (ERR_EMPTY_RESPONSE) and the video
        # never loads, which is worse than just reporting "not found".
        video_url = video_id = None
        suggested_offset = None
        try:
            video_url, video_id = find_video(query)

            first_line = params.get('first_line', [''])[0]
            first_line_time = params.get('first_line_time', [''])[0]
            if video_url and first_line and first_line_time:
                suggested_offset = get_suggested_offset(video_id, first_line, float(first_line_time))
        except EXTERNAL_API_ERRORS as e:
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

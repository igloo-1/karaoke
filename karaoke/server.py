#!/usr/bin/env python3
"""Static file server for the karaoke app.

/api/search  finds a matching YouTube video for a text query.
/api/captions returns that video's caption timing — both cue-level
             (start/end/text), so the client can align each lyric line to
             its own best-matching cue rather than a single global offset,
             and word-level, so the fill animation can follow the singer's
             actual pacing within a line instead of a constant rate.

Both talk to YouTube directly through maintained libraries rather than
third-party Piped mirrors, which failed in nearly every way possible
during development: dead instances, CORS blocks, 500s, empty instance
lists, DNS failures. Requires:
    pip install -r requirements.txt

Run with: python3 server.py [port]
"""
import concurrent.futures
import json
import math
import re
import sys
import threading
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# yt-dlp/youtube-transcript-api manage their own HTTP internally with no
# timeout knob exposed, so every call to them is bounded with one of these
# via a worker thread — neither must ever be able to stall the video from
# loading, no matter how the library or YouTube's response behaves.
SEARCH_TIMEOUT = 15
CAPTIONS_TIMEOUT = 10
# The json3 path costs a yt-dlp metadata extraction plus up to two subtitle
# downloads, so it gets a longer budget than the transcript-api fallback.
# It runs well after the video has started, so slow is survivable; wrong or
# missing is what the client can't recover from.
JSON3_TIMEOUT = 25
# Caption track languages to try, best first. 'en-orig' shows up on videos
# with auto-dubbed audio tracks, where plain 'en' can be a dub of another
# language rather than what is actually being sung.
CAPTION_LANGS = ('en', 'en-orig')
# A catch-all for whatever unexpected shape of error these external
# libraries or a malformed request might raise — none of it should ever be
# able to crash the request handler and leave the browser with no response.
EXTERNAL_API_ERRORS = (TimeoutError, ValueError, KeyError, TypeError, AttributeError, IndexError)


# How many candidates to rank. YouTube's own first hit is regularly a cover, a
# remaster of the wrong length, or another song by the same artist entirely.
SEARCH_RESULTS = 8

# A title saying any of these is not the recording the lyrics were timed
# against, however well it matches otherwise.
WRONG_RECORDING = ('karaoke', 'cover', 'tribute', 'live at', 'live in', 'live from',
                   'live performance', 'reaction', 'remix', 'nightcore', 'sped up',
                   'slowed', '8d audio', 'instrumental', 'backing track', 'tutorial',
                   'parody', 'loop', '1 hour', '10 hours', 'behind the scenes',
                   'making of', 'interview', 'lesson', 'alternate version',
                   # A lyric video would put a second copy of the words on
                   # screen, competing with ours.
                   'lyrics', 'lyric video', 'visualiser', 'visualizer')
# Phrases suggesting this is the canonical upload, best first.
OFFICIAL_MARKERS = (('official music video', 30), ('official video', 28),
                    ('official audio', 24), ('official', 12), ('music video', 8))


def _title_words(text):
    return set(re.findall(r"[a-z0-9']+", (text or '').lower()))


def _score_candidate(entry, track, artist, target_duration):
    """Rank a search hit against the song the lyrics actually belong to.
    Returns None to reject outright."""
    title = entry.get('title') or ''
    lowered = title.lower()
    channel = (entry.get('channel') or entry.get('uploader') or '').lower()

    if entry.get('live_status') in ('is_live', 'was_live', 'is_upcoming'):
        return None

    # Guard against a different song by the same artist, which ranks highly on
    # a plain text search and is otherwise indistinguishable.
    wanted = _title_words(track)
    if wanted:
        overlap = len(_title_words(title) & wanted) / len(wanted)
        if overlap < 0.6:
            return None
        score = 100 * overlap
    else:
        score = 50

    # Only penalise a disqualifying word if it isn't in the song's own title —
    # plenty of real songs are called "Cover Me" or "Live Forever".
    track_lower = (track or '').lower()
    for marker in WRONG_RECORDING:
        if marker in lowered and marker not in track_lower:
            score -= 70

    for phrase, bonus in OFFICIAL_MARKERS:
        if phrase in lowered:
            score += bonus
            break

    if artist:
        # Compare on letters alone: channels drop the spaces and punctuation an
        # artist name has, so "michael jackson" has to match
        # "michaeljacksonVEVO".
        squashed_artist = re.sub(r'[^a-z0-9]', '', artist.lower())
        if squashed_artist and squashed_artist in re.sub(r'[^a-z0-9]', '', channel):
            score += 25
        elif squashed_artist and squashed_artist in re.sub(r'[^a-z0-9]', '', lowered):
            score += 10
        if 'vevo' in channel:
            score += 15
        if channel.endswith('- topic'):  # YouTube's official-audio uploads
            score += 12

    # Runtime says whether this is the same recording, but asymmetrically: the
    # reference duration is the album track, and an official video legitimately
    # runs longer for an intro, spoken section or credits. Something *shorter*
    # than the track is a clip or a radio edit, and the lyrics will run off the
    # end of it.
    duration = entry.get('duration')
    if target_duration and duration:
        difference = duration - target_duration
        if -8 <= difference <= 8:
            score += 40
        elif 8 < difference <= 60:
            # An official video routinely opens with a scene before the first
            # verse; that costs nothing here, since line timings are anchored
            # to the video rather than assumed to start at zero.
            score += 34
        elif -30 <= difference < -8:
            # The reference duration is whichever edition LRCLIB catalogued,
            # which is often a different master to the video — single edits,
            # album versions and fade-outs all disagree by a few seconds.
            score += 12
        else:
            score -= 45

    # Popularity is the clearest signal of which upload is the canonical one —
    # the official release outnumbers the re-uploads by orders of magnitude.
    views = entry.get('view_count') or 0
    if views > 0:
        score += min(50, math.log10(views) * 5.5)

    return score


def _yt_dlp_search(query, track='', artist='', target_duration=None):
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
        info = ydl.extract_info(f'ytsearch{SEARCH_RESULTS}:{query}', download=False)

    entries = [e for e in ((info or {}).get('entries') or []) if e and e.get('id')]
    if not entries:
        return None, None

    ranked = []
    for entry in entries:
        score = _score_candidate(entry, track, artist, target_duration)
        if score is not None:
            ranked.append((score, entry))

    # Everything was rejected: the filters are opinionated, and a song with no
    # canonical upload should still play something rather than nothing.
    best = max(ranked, key=lambda pair: pair[0])[1] if ranked else entries[0]
    print(f'[search] {best.get("title")!r} '
          f'({best.get("duration")}s, {best.get("view_count")} views)')
    return f'https://www.youtube.com/watch?v={best["id"]}', best['id']


def find_video(query, track='', artist='', target_duration=None):
    """Search YouTube directly via yt-dlp. Returns (video_url, video_id),
    either of which may be None."""
    try:
        import yt_dlp  # noqa: F401 (import-availability check)
    except ImportError:
        print('yt-dlp not installed — run: pip install -r requirements.txt')
        return None, None

    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    future = pool.submit(_yt_dlp_search, query, track, artist, target_duration)
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


def _pick_json3_url(tracks_by_lang, native_only):
    """Pick an English json3 caption track URL out of a yt-dlp subtitles or
    automatic_captions mapping. json3 is the only format YouTube exposes that
    carries per-word offsets.

    automatic_captions is keyed '<target>-<source>' and lists a machine
    translation into English from every language YouTube supports — hundreds
    of them. 'en-ar' is Arabic run through a translator, not the words being
    sung, so native_only restricts the pick to English recognised from English
    audio. Manual subtitles carry no translations, so any en-* key there is
    just a regional variant or a track id."""
    tracks_by_lang = tracks_by_lang or {}

    def acceptable(lang):
        if lang in CAPTION_LANGS:
            return True
        if native_only:
            return lang == 'en-en' or lang.startswith('en-en-')
        return lang.startswith('en-')

    # Plain 'en' first, then 'en-orig' (present on videos with auto-dubbed
    # audio, where 'en' can be a dub rather than the original vocal).
    def preference(lang):
        return (lang != 'en', lang != 'en-orig', lang)

    for lang in sorted(tracks_by_lang, key=preference):
        if not acceptable(lang):
            continue
        for track in tracks_by_lang.get(lang) or []:
            if track.get('ext') == 'json3' and track.get('url'):
                return track['url']
    return None


def _download_json(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(request, timeout=CAPTIONS_TIMEOUT) as resp:
        return json.loads(resp.read().decode('utf-8', 'replace'))


def _parse_json3(data):
    """json3 events -> cues. Each cue's segs are the individual words when the
    track is auto-generated (each carrying a tOffsetMs relative to the cue);
    manually authored tracks put the whole cue in one seg with no offsets."""
    cues = []
    for event in data.get('events') or []:
        segs = event.get('segs') or []
        start_ms = event.get('tStartMs')
        if not segs or start_ms is None:
            continue
        text = ''.join(seg.get('utf8', '') for seg in segs)
        # Rolling auto-captions interleave whitespace-only spacer events
        # between the real ones.
        if not text.strip():
            continue

        start = start_ms / 1000.0
        words = []
        for seg in segs:
            word = (seg.get('utf8') or '').strip()
            if word:
                words.append({'start': start + (seg.get('tOffsetMs') or 0) / 1000.0, 'text': word})

        duration_ms = event.get('dDurationMs')
        end = start + duration_ms / 1000.0 if duration_ms else start + 2.0
        cues.append({'start': start, 'end': end, 'text': ' '.join(text.split()), 'words': words})

    # Rolling captions declare durations that run well past the point the next
    # cue appears, which would leave every line's "natural end" overlapping the
    # one after it.
    for i in range(len(cues) - 1):
        cues[i]['end'] = max(cues[i]['start'], min(cues[i]['end'], cues[i + 1]['start']))
    return cues


def _word_stream(cues):
    """Flatten cues into one chronological list of individually-timed words.

    Cue boundaries don't line up with lyric lines — a single auto-caption cue
    routinely ends mid-line and carries the start of the next one — so pacing
    has to be read off a flat stream rather than per-cue."""
    words = []
    for cue in cues:
        # One seg for the whole cue means the track has no intra-cue timing;
        # its "word" is really the entire line and would only add noise.
        if len(cue['words']) < 2:
            continue
        words.extend(word for word in cue['words'] if ' ' not in word['text'])
    words.sort(key=lambda word: word['start'])
    return words


def _fetch_json3_captions(video_id):
    """Runs in a worker thread — see get_youtube_caption_cues for the timeout
    wrapper. Returns (cues, words).

    Manual captions win for cue text (they are the real lyrics, where
    auto-captions mishear constantly), but only auto-captions carry word
    timing — so when a video has both, each is used for what it is good at."""
    import yt_dlp

    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        'writesubtitles': True,
        'writeautomaticsub': True,
        'socket_timeout': CAPTIONS_TIMEOUT,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(f'https://www.youtube.com/watch?v={video_id}', download=False) or {}

    manual_url = _pick_json3_url(info.get('subtitles'), native_only=False)
    auto_url = _pick_json3_url(info.get('automatic_captions'), native_only=True)

    manual_cues = _parse_json3(_download_json(manual_url)) if manual_url else []
    auto_cues = _parse_json3(_download_json(auto_url)) if auto_url else []

    return (manual_cues or auto_cues), _word_stream(auto_cues or manual_cues)


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


def _run_bounded(fn, video_id, timeout):
    """Run one of the caption fetchers in a worker thread with a hard timeout.
    Returns (result, error_message) — the libraries below manage their own HTTP
    with no timeout knob exposed, so this is the only bound available."""
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    future = pool.submit(fn, video_id)
    try:
        return future.result(timeout=timeout), None
    except concurrent.futures.TimeoutError:
        return None, f'timed out after {timeout}s'
    except Exception as e:  # noqa: BLE001 - these libraries' own exception
        # hierarchies (TranscriptsDisabled, NoTranscriptFound, yt-dlp's own
        # tree) aren't worth hard-coding; any failure must degrade gracefully.
        return None, f'{type(e).__name__}: {e}'
    finally:
        pool.shutdown(wait=False)


def get_youtube_caption_cues(video_id):
    """Fetch caption cue timing, plus word timing when the video has
    auto-generated captions. Returns (cues, words, error_message)."""
    errors = []

    # Preferred: json3 via yt-dlp, the only route that carries word offsets.
    try:
        import yt_dlp  # noqa: F401 (import-availability check)
        result, error = _run_bounded(_fetch_json3_captions, video_id, JSON3_TIMEOUT)
        if result and result[0]:
            return result[0], result[1], None
        errors.append(f'json3: {error or "no caption tracks"}')
    except ImportError:
        errors.append('json3: yt-dlp not installed')

    # Fallback: cue-level only, which still drives line sync — the fill just
    # goes back to assuming a constant rate within each line.
    try:
        import youtube_transcript_api  # noqa: F401 (import-availability check)
    except ImportError:
        errors.append('transcript-api: not installed — run: pip install -r requirements.txt')
        return None, [], '; '.join(errors)

    cues, error = _run_bounded(_fetch_transcript_cues, video_id, CAPTIONS_TIMEOUT)
    if not cues:
        errors.append(f'transcript-api: {error or "transcript was empty"}')
        return None, [], '; '.join(errors)
    return cues, [], None


# ── Local word sync (optional) ──────────────────────────────────────────────
#
# YouTube only carries per-word caption timing for roughly a third of songs,
# and where it does exist it is often wrong about the parts that repeat — its
# recogniser hears "Never gonna give you up" as "I will give". Transcribing the
# song here instead covers every song and gets the words right far more often.
#
# It costs about a minute per song, so it lives behind its own endpoint that
# the page asks for *after* the video is already playing and paced from
# captions. If the dependencies are absent — they are a large install and
# deliberately not in requirements.txt — this degrades to exactly the previous
# behaviour.
WORDSYNC_TIMEOUT = 420
# 'medium' measurably beats 'large-v3' on some songs and runs 15x faster, so
# there is nothing to gain from the bigger model here.
# Model size is chosen by what it will run on. On a GPU 'medium' costs seconds
# and paces ~98% of lines, so there is no reason to go smaller. On a CPU the
# same model takes 3.5 minutes a song, where 'small' takes half that for about
# three points of coverage — a trade worth making when the alternative is a
# wait nobody sits through. 'base' is not an option either way: it falls to
# ~65%.
WHISPER_MODELS = {'cuda': 'medium', 'cpu': 'small'}
CACHE_DIR = Path(__file__).resolve().parent / '.wordsync-cache'


def _whisper_device():
    try:
        import torch
        return 'cuda' if torch.cuda.is_available() else 'cpu'
    except ImportError:
        return 'cpu'


def _cache_version():
    """Part of the cache filename: the engine, model and decode settings all
    shape the timings, so a change to any of them should recompute rather than
    silently reuse the old result."""
    return f'fw-{WHISPER_MODELS[_whisper_device()]}'
# One song at a time: these models want most of a GPU to themselves.
_wordsync_lock = threading.Lock()
# Loading the model costs ~20s, which is most of a short song's transcription
# time, so it is kept between requests.
_whisper_model = None
_whisper_model_lock = threading.Lock()

# Rough share of the total wait each stage takes, so the progress bar advances
# at a believable rate rather than sitting still and then jumping.
STAGE_WEIGHTS = (('downloading', 0.08), ('separating vocals', 0.27), ('transcribing', 0.65))

# Live job state, so the page can be told how far along a song is instead of
# holding a request open for a minute with nothing to show.
_jobs = {}
_jobs_lock = threading.Lock()


def _stage_progress(stage_index, fraction):
    done = sum(weight for _, weight in STAGE_WEIGHTS[:stage_index])
    return done + STAGE_WEIGHTS[stage_index][1] * max(0.0, min(1.0, fraction))


def _set_job(video_id, **fields):
    with _jobs_lock:
        job = _jobs.setdefault(video_id, {})
        job.update(fields)
        return dict(job)


def _download_audio(video_id):
    import yt_dlp
    template = str(CACHE_DIR / f'{video_id}.%(ext)s')
    with yt_dlp.YoutubeDL({'format': 'bestaudio/best', 'outtmpl': template,
                           'quiet': True, 'no_warnings': True}) as ydl:
        info = ydl.extract_info(f'https://www.youtube.com/watch?v={video_id}', download=True)
    return Path(ydl.prepare_filename(info))


def _isolate_vocals(source, video_id, report):
    """Strip the backing track. Whisper is a speech model — on a full mix it
    mishears heavily and, over an instrumental passage, invents words that
    aren't there at all."""
    import torch
    from demucs.api import Separator, save_audio

    device = 'cuda' if torch.cuda.is_available() else 'cpu'

    def on_progress(data):
        try:
            models = max(1, data.get('models', 1))
            length = max(1, data.get('audio_length', 1))
            done = (data.get('model_idx_in_bag', 0) + data.get('segment_offset', 0) / length)
            report(1, done / models)
        except Exception:  # noqa: BLE001 - progress must never break the job
            pass

    separator = Separator(model='htdemucs', device=device, callback=on_progress)
    _, stems = separator.separate_audio_file(str(source))
    vocals = CACHE_DIR / f'{video_id}.vocals.wav'
    save_audio(stems['vocals'], str(vocals), samplerate=separator.samplerate)
    return vocals


def _load_whisper():
    global _whisper_model
    with _whisper_model_lock:
        if _whisper_model is None:
            from faster_whisper import WhisperModel
            device = _whisper_device()
            _whisper_model = WhisperModel(
                WHISPER_MODELS[device], device=device,
                compute_type='float16' if device == 'cuda' else 'int8')
            print(f'[wordsync] whisper "{WHISPER_MODELS[device]}" on {device}')
        return _whisper_model


def _transcribe_words(audio_path, report):
    model = _load_whisper()
    # Two settings matter more than the model choice:
    #  - condition_on_previous_text stops the decoder falling into a repetition
    #    loop over a sung intro (one song produced 1300 words of "do" with it on)
    #  - no_speech_threshold is disabled because a voice over a heavy backing
    #    track reads as "not speech" to a speech model, and whole sung passages
    #    were being thrown away. Turning it off took one song from 81% of lines
    #    paced to 98%.
    segments, info = model.transcribe(
        str(audio_path), language='en', word_timestamps=True, beam_size=5,
        condition_on_previous_text=False, no_speech_threshold=None)

    duration = max(1.0, info.duration)
    words = []
    # The generator decodes lazily, so consuming it is what does the work — and
    # each segment's end time is genuine progress through the song.
    for segment in segments:
        for word in segment.words or []:
            text = word.word.strip()
            if text:
                words.append({'start': float(word.start), 'end': float(word.end), 'text': text})
        report(2, segment.end / duration)
    words.sort(key=lambda w: w['start'])
    return words


def _build_word_sync(video_id):
    def report(stage_index, fraction):
        _set_job(video_id, stage=STAGE_WEIGHTS[stage_index][0],
                 progress=_stage_progress(stage_index, fraction))

    source = None
    vocals = None
    try:
        report(0, 0.0)
        source = _download_audio(video_id)
        report(0, 1.0)
        vocals = _isolate_vocals(source, video_id, report)
        return _transcribe_words(vocals, report)
    finally:
        # Only the word list is worth keeping — the audio behind it runs to
        # ~50 MB a song and is never needed again once transcribed.
        for path in (source, vocals):
            if path is not None:
                path.unlink(missing_ok=True)


def _cached_words(video_id):
    cached = CACHE_DIR / f'{video_id}.{_cache_version()}.json'
    if not cached.exists():
        return None
    try:
        return json.loads(cached.read_text(encoding='utf-8'))
    except ValueError:
        cached.unlink(missing_ok=True)
        return None


def _missing_dependency():
    for module, hint in (('torch', 'torch'), ('demucs', 'demucs'),
                         ('faster_whisper', 'faster-whisper')):
        try:
            __import__(module)
        except ImportError:
            return f'{hint} not installed — see requirements-wordsync.txt'
    return None


def _run_word_sync_job(video_id):
    # The lock is taken inside the worker so a queued song still reports itself
    # as running rather than looking stalled.
    with _wordsync_lock:
        words = _cached_words(video_id)
        if words is None:
            words, error = _run_bounded(_build_word_sync, video_id, WORDSYNC_TIMEOUT)
            if not words:
                _set_job(video_id, status='error', progress=0,
                         error=error or 'transcription produced no words')
                return
            (CACHE_DIR / f'{video_id}.{_cache_version()}.json').write_text(
                json.dumps(words), encoding='utf-8')
        _set_job(video_id, status='done', progress=1.0, stage='done', words=words)


def get_word_sync(video_id):
    """Start or check local transcription for a video.

    Returns a status dict rather than blocking: the job runs for a minute or
    more, and a page that can show how far along it is reads as working, where
    the same wait with no feedback reads as broken."""
    CACHE_DIR.mkdir(exist_ok=True)

    words = _cached_words(video_id)
    if words is not None:
        return {'status': 'done', 'progress': 1.0, 'stage': 'cached', 'words': words}

    missing = _missing_dependency()
    if missing:
        return {'status': 'error', 'progress': 0, 'error': missing}

    with _jobs_lock:
        job = _jobs.get(video_id)
        if job is None or job.get('status') == 'error':
            _jobs[video_id] = {'status': 'running', 'progress': 0.0, 'stage': 'queued'}
            threading.Thread(target=_run_word_sync_job, args=(video_id,), daemon=True).start()
            return dict(_jobs[video_id])
        return dict(job)


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Without this the browser keeps serving its own copy of app.js and
        # index.html after an edit, so changes appear not to have taken effect
        # at all — a confusing thing to debug when the server is plainly
        # serving the new file.
        self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/search':
            self.handle_search(parsed.query)
            return
        if parsed.path == '/api/captions':
            self.handle_captions(parsed.query)
            return
        if parsed.path == '/api/wordsync':
            self.handle_wordsync(parsed.query)
            return
        super().do_GET()

    def handle_search(self, query_string):
        params = urllib.parse.parse_qs(query_string)
        query = params.get('q', [''])[0]
        if not query:
            self.send_error(400, 'Missing q parameter')
            return
        track = params.get('track', [''])[0]
        artist = params.get('artist', [''])[0]
        try:
            target_duration = float(params.get('duration', [''])[0])
        except ValueError:
            target_duration = None

        # No matter what unexpected thing yt-dlp throws at us, this endpoint
        # must always respond — a crash here means the browser gets no HTTP
        # response at all (ERR_EMPTY_RESPONSE) and the video never loads.
        video_url = None
        try:
            video_url, _ = find_video(query, track, artist, target_duration)
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
        words = []
        error = None
        try:
            cues, words, error = get_youtube_caption_cues(video_id)
        except EXTERNAL_API_ERRORS as e:
            error = f'{type(e).__name__}: {e}'
            print(f'/api/captions failed unexpectedly: {error}')

        self._send_json({'cues': cues, 'words': words, 'error': error})

    def handle_wordsync(self, query_string):
        params = urllib.parse.parse_qs(query_string)
        video_id = params.get('v', [''])[0]
        if not video_id:
            self.send_error(400, 'Missing v parameter')
            return

        try:
            state = get_word_sync(video_id)
        except EXTERNAL_API_ERRORS as e:
            state = {'status': 'error', 'progress': 0, 'error': f'{type(e).__name__}: {e}'}
        if state.get('error'):
            print(f'/api/wordsync unavailable for {video_id}: {state["error"]}')
        self._send_json({
            'status': state.get('status', 'running'),
            'progress': round(state.get('progress', 0.0), 3),
            'stage': state.get('stage', ''),
            'words': state.get('words', []),
            'error': state.get('error'),
        })

    def _send_json(self, data):
        body = json.dumps(data).encode()
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except ConnectionError:
            # /api/wordsync can take minutes, so a listener moving to another
            # song mid-request is routine rather than an error. Without this the
            # console fills with stack traces for something entirely normal.
            self.close_connection = True


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(('', port), Handler)
    print(f'Serving karaoke app on http://localhost:{port}')
    server.serve_forever()

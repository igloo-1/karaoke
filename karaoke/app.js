// ═══════════════════════════════════════════
//  State
// ═══════════════════════════════════════════

const state = {
    apiReady: false,
    player: null,
    playerReady: false,
    currentVideoId: null, // guards slow background refinements against a song change
    lyrics: [],         // [{time: seconds, text: "..."}, ...] — from LRCLIB
    lineTimes: [],      // [{start, end}, ...] parallel to lyrics, in video-timeline seconds
    currentLineIndex: -1,
    renderKey: null,    // tracks what's on screen so we only re-render on change
    syncOffset: 0,
    animFrameId: null,
};

// A gap to the next line longer than this is treated as an instrumental
// break; INSTRUMENTAL_HOLD is how long a line stays on screen after its own
// natural end (not the next line's start) before switching to the
// instrumental indicator.
const INSTRUMENTAL_GAP_THRESHOLD = 8;
const INSTRUMENTAL_HOLD = 2;
// Without a caption match, a line's own natural end is a guess — cap it so
// a long instrumental gap to the next line can't make the fill animation
// look like it's still "singing" the previous line the whole time.
const MAX_LINE_FILL_DURATION = 7;
// Minimum word-overlap (Jaccard) similarity to accept a caption cue as a
// match for a lyric line, to avoid false positives on generic words.
const MIN_CAPTION_MATCH_SCORE = 0.34;

// ═══════════════════════════════════════════
//  DOM refs
// ═══════════════════════════════════════════

const searchScreen = document.getElementById('search-screen');
const playerScreen = document.getElementById('player-screen');
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const resultsDiv = document.getElementById('results');
const backBtn = document.getElementById('back-btn');
const offsetSlider = document.getElementById('offset-slider');
const offsetValue = document.getElementById('offset-value');
const tapSyncBtn = document.getElementById('tap-sync-btn');
const tapSyncDefaultText = tapSyncBtn.textContent;
const fullscreenBtn = document.getElementById('fullscreen-btn');
const playBtn = document.getElementById('play-btn');
const muteBtn = document.getElementById('mute-btn');
const volumeSlider = document.getElementById('volume');
const seekEl = document.getElementById('seek');
const seekPlayed = document.getElementById('seek-played');
const seekBuffer = document.getElementById('seek-buffer');
const seekHandle = document.getElementById('seek-handle');
const timeCurrent = document.getElementById('time-current');
const timeTotal = document.getElementById('time-total');
const clickLayer = document.getElementById('click-layer');
const syncStatus = document.getElementById('sync-status');
const syncProgress = document.getElementById('sync-progress');
const syncProgressBar = document.getElementById('sync-progress-bar');
const stageEl = document.getElementById('stage');
const lyricsPrev = document.getElementById('lyrics-prev');
const lyricsCurrent = document.getElementById('lyrics-current');
const lyricsNext = document.getElementById('lyrics-next');

// ═══════════════════════════════════════════
//  YouTube IFrame API
// ═══════════════════════════════════════════

// YouTube API calls this global function when its JS has loaded. The
// player itself is created lazily in ensurePlayer(), not here — creating
// a YT.Player while #player-screen is still display:none (true at this
// point, on every page load) causes its onReady to intermittently never
// fire at all, silently, with no console error.
window.onYouTubeIframeAPIReady = () => {
    console.log('[karaoke] onYouTubeIframeAPIReady fired');
    state.apiReady = true;
};

// YouTube embed error codes, for the onError handler below.
const YT_ERROR_MESSAGES = {
    2: 'invalid video ID',
    5: 'HTML5 player error',
    100: 'video not found or removed',
    101: 'embedding disabled by video owner',
    150: 'embedding disabled by video owner',
};

// If apiReady never flips true within this long, something is actually
// wrong (the iframe_api script failed to load or never called back —
// commonly an ad blocker or extension blocking youtube.com) rather than
// just being slow, so stop polling silently forever and say so.
const API_READY_TIMEOUT = 15000;
let apiReadyWaitStarted = null;

// onYouTubeIframeAPIReady is a one-shot global that YouTube calls the moment
// its script finishes loading. If that lands before app.js has been parsed,
// nothing is registered yet and the callback simply never runs — so trusting
// state.apiReady alone would wait out the full timeout and then blame an ad
// blocker for an API that is sitting right there, fully loaded. YT.Player
// existing is the real readiness signal; the flag is just the fast path.
function isYouTubeApiReady() {
    return state.apiReady
        || !!(window.YT && window.YT.loaded && typeof window.YT.Player === 'function');
}

// The video's own subtitles are these same lyrics, drawn by the player over
// the top of ours and timed a beat differently — two overlapping copies of
// every line. cc_load_policy only sets a default that a stored caption
// preference overrides, so the module is unloaded outright. Which name works
// depends on the player build, and loading a video can re-enable it, so this
// runs on every load.
function hideYouTubeCaptions() {
    if (!state.player || !state.playerReady) return;
    for (const module of ['captions', 'cc']) {
        try {
            state.player.unloadModule(module);
        } catch (err) {
            /* player builds expose one name or the other */
        }
    }
}

function ensurePlayer(videoId) {
    if (state.player && state.playerReady) {
        console.log('[karaoke] ensurePlayer: player already ready, loading', videoId);
        state.player.loadVideoById(videoId);
        hideYouTubeCaptions();
        startTransport();
        return;
    }
    const apiReady = isYouTubeApiReady();
    if (state.player || !apiReady) {
        if (window.__youtubeApiScriptFailed) {
            console.error('[karaoke] The YouTube iframe_api script failed to load (network error). '
                + 'An ad blocker or browser extension is the most likely cause — try disabling it for this page.');
            alert('Could not load the YouTube player: the youtube.com script failed to load. '
                + 'This is usually an ad blocker or extension blocking youtube.com — try disabling it for this page.');
            apiReadyWaitStarted = null;
            return;
        }
        if (!apiReady) {
            if (apiReadyWaitStarted === null) apiReadyWaitStarted = Date.now();
            if (Date.now() - apiReadyWaitStarted > API_READY_TIMEOUT) {
                console.error('[karaoke] Gave up waiting for the YouTube iframe API after '
                    + `${API_READY_TIMEOUT / 1000}s — onYouTubeIframeAPIReady never fired. `
                    + 'Check the Network tab for a request to youtube.com/iframe_api and whether '
                    + 'it succeeded; an ad blocker or extension is the most likely cause.');
                alert('Could not load the YouTube player after waiting 15 seconds. '
                    + 'Check your browser console/Network tab for a blocked request to youtube.com — '
                    + 'an ad blocker or extension is the most likely cause.');
                apiReadyWaitStarted = null;
                return;
            }
        } else {
            apiReadyWaitStarted = null;
        }
        // Either already mid-creation (waiting on its onReady) or the
        // YouTube API script itself hasn't finished loading yet.
        console.log('[karaoke] ensurePlayer: waiting —', { hasPlayer: !!state.player, apiReady });
        setTimeout(() => ensurePlayer(videoId), 200);
        return;
    }

    console.log('[karaoke] ensurePlayer: creating YT.Player for', videoId);
    state.player = new YT.Player('youtube-player', {
        height: '100%',
        width: '100%',
        playerVars: {
            autoplay: 0,
            controls: 0, // replaced by #player-bar — YouTube's own chrome sits
                         // under the lyrics overlay and can't be reached
            disablekb: 1,
            rel: 0,
            modestbranding: 1,
            cc_load_policy: 0, // see hideYouTubeCaptions — this alone is only a
                               // default, and a saved preference overrides it

            fs: 0, // YouTube's own fullscreen only fullscreens the iframe,
                   // which hides the lyrics overlay — use our own button instead
        },
        events: {
            onReady: () => {
                console.log('[karaoke] player onReady fired, loading', videoId);
                state.playerReady = true;
                state.player.loadVideoById(videoId);
                hideYouTubeCaptions();
                renderVolume();
                startTransport();
            },
            onError: (e) => {
                console.error('[karaoke] player onError:', e.data, YT_ERROR_MESSAGES[e.data] || 'unknown');
            },
            onStateChange: (e) => {
                setPlayIcon(e.data === YT.PlayerState.PLAYING);
                renderTransport();
                if (e.data === YT.PlayerState.PLAYING) {
                    hideYouTubeCaptions();
                    renderVolume();
                    startLyricsLoop();
                    wakeControls();
                } else {
                    stopLyricsLoop();
                    // Anything that isn't playing wants the controls visible.
                    stageEl.classList.remove('idle');
                    clearTimeout(idleTimer);
                }
            }
        }
    });
}

// ═══════════════════════════════════════════
//  Search
// ═══════════════════════════════════════════

searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
});

async function doSearch() {
    const query = searchInput.value.trim();
    if (!query) return;

    resultsDiv.innerHTML = '<div class="result-loading">Searching...</div>';

    try {
        // Search LRCLIB for synced lyrics
        const lrcResults = await searchLRCLIB(query);

        if (lrcResults.length === 0) {
            resultsDiv.innerHTML = '<div class="result-error">No synced lyrics found. Try a different search.</div>';
            return;
        }

        resultsDiv.innerHTML = '';
        lrcResults.forEach((item) => {
            const div = document.createElement('div');
            div.className = 'result-item';

            const duration = item.duration ? formatTime(item.duration) : '??';

            div.innerHTML = `
                <div class="result-info">
                    <div class="result-title">${escapeHtml(item.trackName)}</div>
                    <div class="result-artist">${escapeHtml(item.artistName)}${item.albumName ? ' • ' + escapeHtml(item.albumName) : ''}</div>
                </div>
                <div class="result-duration">${duration}</div>
            `;

            div.addEventListener('click', () => selectSong(item));
            resultsDiv.appendChild(div);
        });

    } catch (err) {
        console.error(err);
        resultsDiv.innerHTML = '<div class="result-error">Search failed. Check console for details.</div>';
    }
}

async function searchLRCLIB(query) {
    const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`LRCLIB search failed: ${resp.status}`);
    const data = await resp.json();

    // Filter to only results that have synced lyrics
    return data.filter(item => item.syncedLyrics && item.syncedLyrics.trim().length > 0);
}

// ═══════════════════════════════════════════
//  Song Selection
// ═══════════════════════════════════════════

async function selectSong(lrcItem) {
    // Parse synced lyrics, and set up fallback line timings immediately
    // (pure LRC-relative) so the lyrics display works right away — these
    // get replaced with caption-anchored timings below if that succeeds,
    // but that must never block the video from loading.
    state.lyrics = parseLRC(lrcItem.syncedLyrics);
    state.lineTimes = computeFallbackLineTimes(state.lyrics);
    state.currentLineIndex = -1;

    let videoId;

    try {
        videoId = await searchYouTube(lrcItem);
    } catch (err) {
        console.error('YouTube search failed:', err);
        alert('Could not find a YouTube video for this song.');
        return;
    }

    if (!videoId) {
        alert('No YouTube video found.');
        return;
    }

    state.currentVideoId = videoId;

    // Switch to player screen
    searchScreen.classList.add('hidden');
    playerScreen.classList.remove('hidden');

    offsetSlider.min = -30;
    offsetSlider.max = 30;
    setSyncOffset(0);

    // Clear lyrics display
    clearLyricsDisplay();

    // Load video. #player-screen is visible by this point (see above),
    // so it's now safe for ensurePlayer to create the YouTube iframe.
    ensurePlayer(videoId);

    // Best-effort: refine line timings from the video's own captions once
    // they're fetched. Runs after the video is already loading so it can
    // never delay playback.
    alignToCaptions(videoId);
}

async function searchYouTube(lrcItem) {
    // yt-dlp runs server-side (server.py's /api/search route) since it's a
    // Python library, not something the browser can call directly. The track
    // details go with the query so the server can rank candidates rather than
    // taking YouTube's first hit — which is regularly a cover, a remaster of
    // the wrong length, or a different song by the same artist.
    const params = new URLSearchParams({
        q: `${lrcItem.trackName} ${lrcItem.artistName} official music video`,
        track: lrcItem.trackName || '',
        artist: lrcItem.artistName || '',
    });
    if (lrcItem.duration) params.set('duration', lrcItem.duration);

    const resp = await fetch(`/api/search?${params}`);
    if (!resp.ok) throw new Error(`Search request failed: ${resp.status}`);

    const data = await resp.json();
    if (!data.url) return null;

    // Extract video ID from URL like /watch?v=XXXXX
    const match = data.url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
}

// ═══════════════════════════════════════════
//  Caption-based per-line sync
// ═══════════════════════════════════════════

function normalizeWords(text) {
    const matches = text.toLowerCase().match(/[a-z0-9']+/g);
    return matches ? new Set(matches) : new Set();
}

function wordOverlapScore(wordsA, wordsB) {
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    let intersection = 0;
    for (const w of wordsA) {
        if (wordsB.has(w)) intersection++;
    }
    const union = wordsA.size + wordsB.size - intersection;
    return intersection / union; // Jaccard similarity
}

// Short lines (a single interjection, etc.) are exactly the kind of text
// that spuriously matches almost any nearby cue sharing that one word —
// including a caption cue sitting inside an instrumental gap where an
// ad-lib or background sound got auto-transcribed. Require a much higher
// score for them.
const SHORT_LINE_WORD_COUNT = 2;
const SHORT_LINE_MIN_SCORE = 0.66;
// A genuine match should track the LRC's own internal timing fairly
// consistently; if a candidate's (cue time - LRC time) offset deviates
// from the pack by more than this, it's almost always a false positive
// rather than the video genuinely restructuring the song by that much.
const OFFSET_OUTLIER_TOLERANCE = 20;

// Score every (line, cue) pair, zeroing out anything below that line's
// required threshold so the alignment below never even considers it.
function buildScoreMatrix(lyrics, sortedCues, cueWordSets) {
    return lyrics.map((line) => {
        const lineWords = normalizeWords(line.text);
        const requiredScore = lineWords.size <= SHORT_LINE_WORD_COUNT
            ? SHORT_LINE_MIN_SCORE
            : MIN_CAPTION_MATCH_SCORE;
        return cueWordSets.map((cueWords) => {
            const score = wordOverlapScore(lineWords, cueWords);
            return score >= requiredScore ? score : 0;
        });
    });
}

// Pair up two chronological sequences so the total score is as high as
// possible while preserving order: whatever row i pairs with must come after
// whatever row i-1 paired with. A score of 0 means "not a permissible pair".
// Returns, for each row, the column it paired with, or -1 for none.
//
// Matching each row to its best-scoring column independently instead falls
// apart the moment a sequence repeats itself — every repetition scores the
// same against every occurrence, so they all collapse onto whichever one
// happens to win. Order is what tells repetitions apart.
function monotonicAlign(scores, rowCount, colCount) {
    // dp[i][j] = best achievable total over the first i rows and j columns.
    // Skipping either side is free: a lyric line with no caption and a caption
    // cue with no lyric are both routine.
    const dp = Array.from({ length: rowCount + 1 }, () => new Float64Array(colCount + 1));
    for (let i = 1; i <= rowCount; i++) {
        for (let j = 1; j <= colCount; j++) {
            const skip = Math.max(dp[i - 1][j], dp[i][j - 1]);
            const score = scores[i - 1][j - 1];
            dp[i][j] = score > 0 ? Math.max(skip, dp[i - 1][j - 1] + score) : skip;
        }
    }

    // Walk the table back to recover which pairs that total was made of.
    const pairing = new Array(rowCount).fill(-1);
    let i = rowCount;
    let j = colCount;
    while (i > 0 && j > 0) {
        const score = scores[i - 1][j - 1];
        if (score > 0 && dp[i][j] === dp[i - 1][j - 1] + score) {
            pairing[i - 1] = j - 1;
            i--;
            j--;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
            i--;
        } else {
            j--;
        }
    }
    return pairing;
}

function findMonotonicCaptionMatches(lyrics, sortedCues, cueWordSets) {
    const scores = buildScoreMatrix(lyrics, sortedCues, cueWordSets);
    const pairing = monotonicAlign(scores, lyrics.length, sortedCues.length);
    return pairing.map(j => (j === -1 ? null : sortedCues[j]));
}

// The reference offset for outlier rejection is the middle of the *densest*
// group of candidate offsets, not their median. When matches do split into
// several groups, a median can land in the gap between them — or inside a
// smaller wrong one — and then reject the genuine majority as the outliers,
// which is worse than having done no caption alignment at all.
function densestOffsetCluster(offsets) {
    const sorted = [...offsets].sort((a, b) => a - b);
    let bestStart = 0;
    let bestCount = 0;
    let lo = 0;
    for (let hi = 0; hi < sorted.length; hi++) {
        while (sorted[hi] - sorted[lo] > OFFSET_OUTLIER_TOLERANCE) lo++;
        if (hi - lo + 1 > bestCount) {
            bestCount = hi - lo + 1;
            bestStart = lo;
        }
    }
    const cluster = sorted.slice(bestStart, bestStart + bestCount);
    return cluster[Math.floor(cluster.length / 2)];
}

function alignLyricsToCaptions(lyrics, cues) {
    const sortedCues = [...cues].sort((a, b) => a.start - b.start);
    const cueWordSets = sortedCues.map(c => normalizeWords(c.text));
    const candidates = findMonotonicCaptionMatches(lyrics, sortedCues, cueWordSets);

    // Reject matches whose implied offset from the LRC's own timing sits far
    // from the bulk of the others. Ordering alone doesn't stop a line from
    // latching onto a wrong-but-similarly-worded cue, and one bad anchor
    // drags every interpolated line around it out of sync.
    const offsets = [];
    candidates.forEach((c, i) => { if (c) offsets.push(c.start - lyrics[i].time); });
    if (offsets.length === 0) return new Array(lyrics.length).fill(null);
    const referenceOffset = densestOffsetCluster(offsets);

    // Chronological order needs no pass of its own any more — it's
    // structural, since findMonotonicCaptionMatches can only ever assign a
    // later line to a later cue.
    const aligned = new Array(lyrics.length).fill(null);
    candidates.forEach((cue, i) => {
        if (!cue) return;
        if (Math.abs((cue.start - lyrics[i].time) - referenceOffset) > OFFSET_OUTLIER_TOLERANCE) return;
        aligned[i] = { start: cue.start, end: cue.end };
    });

    return aligned;
}

// Builds the final {start, end} video-timeline timing for every lyric
// line: matched lines use their cue's real timing directly; unmatched
// lines are interpolated between the nearest matched neighbors (or
// extrapolated from the nearest single match), so one bad match doesn't
// leave a whole stretch of lines unsynced.
function computeLineTimesFromCaptions(lyrics, cues) {
    const aligned = alignLyricsToCaptions(lyrics, cues);
    const anchors = [];
    aligned.forEach((m, i) => { if (m) anchors.push(i); });
    if (anchors.length === 0) return null;

    const fallbackOffset = aligned[anchors[0]].start - lyrics[anchors[0]].time;

    function estimatedStart(i) {
        let prev = null, next = null;
        for (const idx of anchors) {
            if (idx <= i) prev = idx;
            if (idx >= i && next === null) next = idx;
        }
        if (prev !== null && next !== null && prev !== next) {
            const t = (lyrics[i].time - lyrics[prev].time) / (lyrics[next].time - lyrics[prev].time);
            return aligned[prev].start + t * (aligned[next].start - aligned[prev].start);
        }
        if (prev !== null) return aligned[prev].start + (lyrics[i].time - lyrics[prev].time);
        if (next !== null) return aligned[next].start - (lyrics[next].time - lyrics[i].time);
        return lyrics[i].time + fallbackOffset;
    }

    const starts = lyrics.map((line, i) => (aligned[i] ? aligned[i].start : estimatedStart(i)));

    return lyrics.map((line, i) => {
        const nextStart = (i + 1 < lyrics.length) ? starts[i + 1] : starts[i] + 5;
        const end = aligned[i]
            ? aligned[i].end
            : Math.min(nextStart, starts[i] + MAX_LINE_FILL_DURATION);
        return { start: starts[i], end };
    });
}

// Pure LRC-relative timings, used immediately on song load and as the
// permanent fallback if captions never resolve or nothing matches.
function computeFallbackLineTimes(lyrics) {
    return lyrics.map((line, i) => {
        const nextStart = (i + 1 < lyrics.length) ? lyrics[i + 1].time : line.time + 5;
        const end = Math.min(nextStart, line.time + MAX_LINE_FILL_DURATION);
        return { start: line.time, end };
    });
}

// ═══════════════════════════════════════════
//  Within-line word pacing
// ═══════════════════════════════════════════

// Singers do not cover a line at a constant rate — a phrase is often rushed
// and then its last word held for a bar or more — so spreading a line's
// duration evenly over its characters visibly drifts against the vocal.
// YouTube's auto-captions carry a real timestamp per word, which is the only
// honest source for that pacing.

// How far either side of a line to look for its words in the caption stream,
// covering ordinary sync slop between the LRC line and the captions.
const PACING_WINDOW_PAD = 2.5;
// Below this share of a line's words landing on a caption word, the pacing is
// too speculative to beat spreading the line out evenly.
const MIN_PACED_WORD_FRACTION = 0.4;
// A held final word still has to finish sometime.
const MIN_LAST_WORD_DURATION = 0.3;
// How far past the cue's own end a held final word may run. The caption
// stream knows the singer is still on that word until the next one starts,
// but the next word can be a whole instrumental away.
const MAX_LAST_WORD_EXTENSION = 2;

function splitWords(text) {
    return text.split(/\s+/).filter(word => word.length > 0);
}

// "Don't," and "dont" have to compare equal — captions and LRC lyrics
// punctuate differently, and auto-captions often not at all.
function normalizeToken(word) {
    const matches = word.toLowerCase().match(/[a-z0-9]+/g);
    return matches ? matches.join('') : '';
}

function firstIndexAtOrAfter(words, time) {
    let lo = 0;
    let hi = words.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (words[mid].start < time) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// Fills in the words that didn't match a caption word, by spreading them
// across the time between the matches that bracket them in proportion to
// their length — the same even-rate assumption as before, but now applied
// only to the short stretches between real timestamps rather than to a whole
// line at once.
function interpolateUnmatchedWords(starts, words, lineStart, lineEnd) {
    // Character position of each word within the line, so interpolation
    // weights long words more heavily than short ones.
    const positions = [0];
    words.forEach(word => positions.push(positions[positions.length - 1] + word.length + 1));

    const points = [];
    if (starts[0] === null) points.push({ pos: 0, time: lineStart });
    starts.forEach((start, i) => { if (start !== null) points.push({ pos: positions[i], time: start }); });
    if (starts[starts.length - 1] === null) {
        points.push({ pos: positions[words.length], time: Math.max(lineEnd, points[points.length - 1].time) });
    }

    const resolved = starts.slice();
    let next = 0;
    for (let i = 0; i < words.length; i++) {
        if (resolved[i] !== null) continue;
        while (next < points.length && points[next].pos <= positions[i]) next++;
        const after = points[Math.min(next, points.length - 1)];
        const before = points[Math.max(next - 1, 0)];
        const span = after.pos - before.pos;
        const t = span > 0 ? (positions[i] - before.pos) / span : 0;
        resolved[i] = before.time + t * (after.time - before.time);
    }

    // A caption word can land marginally out of order against the line it was
    // matched into; the fill would jump backwards if that survived.
    for (let i = 1; i < resolved.length; i++) {
        if (resolved[i] < resolved[i - 1]) resolved[i] = resolved[i - 1];
    }
    return resolved;
}

// Returns one start time per word of the line plus a closing boundary for the
// final word (so the array is one longer than the line's word count), or null
// to leave the caller on the even-rate fallback.
function computeWordStarts(lineText, lineStart, lineEnd, wordStream) {
    const words = splitWords(lineText);
    if (words.length < 2 || wordStream.length === 0) return null;

    const from = firstIndexAtOrAfter(wordStream, lineStart - PACING_WINDOW_PAD);
    const to = firstIndexAtOrAfter(wordStream, lineEnd + PACING_WINDOW_PAD);
    const window = wordStream.slice(from, to);
    if (window.length === 0) return null;

    const lineTokens = words.map(normalizeToken);
    const captionTokens = window.map(entry => normalizeToken(entry.text));
    const scores = lineTokens.map(token => captionTokens.map(
        other => (token && token === other ? 1 : 0)));
    const pairing = monotonicAlign(scores, lineTokens.length, captionTokens.length);

    const matched = pairing.filter(index => index >= 0).length;
    if (matched < Math.max(2, Math.ceil(words.length * MIN_PACED_WORD_FRACTION))) return null;

    const starts = pairing.map(index => (index >= 0 ? window[index].start : null));
    const resolved = interpolateUnmatchedWords(starts, words, lineStart, lineEnd);

    // The singer has moved on by the time the next caption word starts, which
    // is a truer end for a held final word than the cue's own end — cues
    // routinely close on the beat and clip the note still being sung.
    const lastMatched = from + Math.max(...pairing);
    const following = wordStream[lastMatched + 1];
    let terminal = following ? following.start : lineEnd;
    terminal = Math.min(terminal, lineEnd + MAX_LAST_WORD_EXTENSION);
    terminal = Math.max(terminal, resolved[resolved.length - 1] + MIN_LAST_WORD_DURATION);

    return [...resolved, terminal];
}

function applyWordPacing(lineTimes, lyrics, wordStream) {
    if (!wordStream || wordStream.length === 0) return 0;
    let paced = 0;
    lineTimes.forEach((lineTime, i) => {
        const starts = computeWordStarts(lyrics[i].text, lineTime.start, lineTime.end, wordStream);
        if (!starts) return;
        lineTime.wordStarts = starts;
        paced++;
    });
    return paced;
}

// The caption word stream only exists on the minority of videos YouTube has
// auto-captioned, and even there it mishears repeated sections badly. The
// server can transcribe the song itself and do far better, but that takes
// about a minute — so it is asked for last, in the background, and folded in
// whenever it arrives. The song is already playing and already paced from
// whatever the captions gave us by this point.
async function refineWordPacing(videoId, alreadyPaced) {
    // Songs the captions already paced in full have nothing to gain.
    if (alreadyPaced >= state.lineTimes.length) return;

    let words;
    try {
        words = await pollWordSync(videoId);
    } catch (err) {
        console.warn('[karaoke] word sync unavailable:', err.message || err);
        setSyncStatus('');
        return;
    }
    if (!words || words.length === 0) {
        setSyncStatus('');
        return;
    }

    // The video can have been swapped for another song while this was running.
    if (state.currentVideoId !== videoId) return;

    const lineTimes = state.lineTimes.map(lt => ({ start: lt.start, end: lt.end }));
    const paced = applyWordPacing(lineTimes, state.lyrics, words);
    if (paced <= alreadyPaced) {
        setSyncStatus('');
        return;
    }

    console.log(`[karaoke] local word sync: ${paced}/${lineTimes.length} lines paced `
        + `(captions managed ${alreadyPaced})`);
    state.lineTimes = lineTimes;
    state.renderKey = null;
    setSyncStatus(`Word sync ready — ${paced}/${lineTimes.length} lines`, 'done');
    setTimeout(() => setSyncStatus(''), 4000);
}

function setSyncStatus(text, className = '') {
    syncStatus.textContent = text;
    syncStatus.className = className;
    // The bar only belongs to the in-progress message, so it retires with it
    // rather than needing to be cleared at every exit.
    if (className !== 'working') setSyncProgress(null);
}

function setSyncProgress(fraction) {
    if (fraction === null) {
        syncProgress.classList.add('hidden');
        syncProgressBar.style.width = '0%';
        return;
    }
    syncProgress.classList.remove('hidden');
    syncProgressBar.style.width = `${Math.round(fraction * 100)}%`;
}

// Transcribing runs for a minute or more, so the server hands back progress
// instead of holding the request open. A cached song answers 'done' on the
// first ask, so the bar is only shown once we know there is a real wait.
const WORDSYNC_POLL_INTERVAL = 1000;
const WORDSYNC_MAX_WAIT = 480000;

async function pollWordSync(videoId) {
    const startedAt = Date.now();
    let shownBar = false;

    while (Date.now() - startedAt < WORDSYNC_MAX_WAIT) {
        const resp = await fetch(`/api/wordsync?v=${encodeURIComponent(videoId)}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        if (data.error) throw new Error(data.error);
        if (data.status === 'done') return data.words;
        // Abandon the wait if the listener has moved on to another song.
        if (state.currentVideoId !== videoId) return null;

        if (!shownBar) {
            shownBar = true;
            setSyncStatus('Improving word sync', 'working');
        }
        setSyncProgress(data.progress || 0);
        if (data.stage) setSyncStatus(`Improving word sync — ${data.stage}`, 'working');

        await new Promise(resolve => setTimeout(resolve, WORDSYNC_POLL_INTERVAL));
    }
    throw new Error('timed out waiting for word sync');
}

async function alignToCaptions(videoId) {
    let cues;
    let words;
    try {
        const resp = await fetch(`/api/captions?v=${encodeURIComponent(videoId)}`);
        if (!resp.ok) return;
        const data = await resp.json();
        cues = data.cues;
        words = data.words;
    } catch (err) {
        console.warn('Caption fetch failed:', err);
        return;
    }
    if (!cues || cues.length === 0) return;

    const lineTimes = computeLineTimesFromCaptions(state.lyrics, cues);
    if (!lineTimes) return; // nothing matched with enough confidence

    const paced = applyWordPacing(lineTimes, state.lyrics, words || []);
    console.log(`[karaoke] caption sync: ${lineTimes.length} lines, ${paced} word-paced`);

    state.lineTimes = lineTimes;
    state.renderKey = null; // force re-render with the refined timings

    // Captions leave most songs unpaced — see refineWordPacing.
    refineWordPacing(videoId, paced);

    tapSyncBtn.textContent = 'Auto-synced from captions!';
    setTimeout(() => { tapSyncBtn.textContent = tapSyncDefaultText; }, 2000);
}

// ═══════════════════════════════════════════
//  LRC Parser
// ═══════════════════════════════════════════

function parseLRC(lrcText) {
    const lines = lrcText.split('\n');
    const parsed = [];

    for (const line of lines) {
        // Match [mm:ss.xx] or [mm:ss.xxx]
        const match = line.match(/^\[(\d{1,3}):(\d{2})\.(\d{2,3})\]\s*(.*)$/);
        if (match) {
            const minutes = parseInt(match[1]);
            const seconds = parseInt(match[2]);
            const ms = match[3].length === 2 ? parseInt(match[3]) * 10 : parseInt(match[3]);
            const time = minutes * 60 + seconds + ms / 1000;
            const text = match[4].trim();

            if (text.length > 0) {
                parsed.push({ time, text });
            }
        }
    }

    return parsed.sort((a, b) => a.time - b.time);
}

// ═══════════════════════════════════════════
//  Lyrics Rendering & Animation Loop
// ═══════════════════════════════════════════

function startLyricsLoop() {
    stopLyricsLoop();
    function loop() {
        updateLyrics();
        state.animFrameId = requestAnimationFrame(loop);
    }
    state.animFrameId = requestAnimationFrame(loop);
}

function stopLyricsLoop() {
    if (state.animFrameId) {
        cancelAnimationFrame(state.animFrameId);
        state.animFrameId = null;
    }
}

function updateLyrics() {
    if (!state.player || !state.playerReady) return;
    if (state.lyrics.length === 0) return;

    const currentTime = state.player.getCurrentTime() + state.syncOffset;

    // Find current line index (by each line's own start on the video timeline)
    let lineIndex = -1;
    for (let i = state.lineTimes.length - 1; i >= 0; i--) {
        if (currentTime >= state.lineTimes[i].start) {
            lineIndex = i;
            break;
        }
    }

    let isInstrumental = false;
    let lineStart = null;
    let lineNaturalEnd = null;
    if (lineIndex >= 0) {
        const lt = state.lineTimes[lineIndex];
        lineStart = lt.start;
        lineNaturalEnd = lt.end;
        const nextLineStart = (lineIndex + 1 < state.lineTimes.length)
            ? state.lineTimes[lineIndex + 1].start
            : lineStart + 5; // assume 5 seconds for last line

        // The gap is the silence after this line finishes, so it runs from its
        // natural end — measuring from its *start* folded the line's own
        // duration into the gap, so a line that simply took a while to sing
        // tripped the threshold and flashed the indicator up for a second or
        // two between two perfectly ordinary lines.
        const gapDuration = nextLineStart - lineNaturalEnd;
        isInstrumental = gapDuration > INSTRUMENTAL_GAP_THRESHOLD
            && currentTime > lineNaturalEnd + INSTRUMENTAL_HOLD;
    }

    // Only re-render when what should be on screen actually changes
    const renderKey = isInstrumental ? `instrumental:${lineIndex}` : `line:${lineIndex}`;
    if (renderKey !== state.renderKey) {
        state.renderKey = renderKey;
        state.currentLineIndex = lineIndex;
        if (isInstrumental) {
            renderInstrumental(lineIndex);
        } else {
            renderLines(lineIndex);
        }
    }

    // Update fill animation on current line — capped at its own natural end,
    // so it finishes at a sensible pace instead of creeping across a gap.
    if (!isInstrumental && lineIndex >= 0 && lineIndex < state.lyrics.length) {
        updateFill(lyricsCurrent, currentTime, lineStart, lineNaturalEnd,
            state.lineTimes[lineIndex].wordStarts);
    }
}

function renderInstrumental(currentIdx) {
    lyricsPrev.textContent = currentIdx >= 0 ? state.lyrics[currentIdx].text : '';
    lyricsCurrent.innerHTML = '<span class="lyrics-instrumental">♪ ♪ ♪</span>';
    lyricsNext.textContent = (currentIdx + 1 < state.lyrics.length)
        ? state.lyrics[currentIdx + 1].text
        : '';
}

function renderLines(currentIdx) {
    // Previous line
    if (currentIdx > 0) {
        lyricsPrev.textContent = state.lyrics[currentIdx - 1].text;
    } else {
        lyricsPrev.textContent = '';
    }

    // Current line — render as words with fill spans
    if (currentIdx >= 0 && currentIdx < state.lyrics.length) {
        renderWordsWithFill(lyricsCurrent, state.lyrics[currentIdx].text);
    } else {
        lyricsCurrent.innerHTML = '';
    }

    // Next line
    if (currentIdx >= 0 && currentIdx + 1 < state.lyrics.length) {
        lyricsNext.textContent = state.lyrics[currentIdx + 1].text;
    } else if (currentIdx === -1 && state.lyrics.length > 0) {
        lyricsNext.textContent = state.lyrics[0].text;
    } else {
        lyricsNext.textContent = '';
    }
}

function renderWordsWithFill(container, text) {
    const words = splitWords(text);
    container.innerHTML = '';

    words.forEach((word) => {
        const span = document.createElement('span');
        span.className = 'lyrics-word';
        span.textContent = word;

        const fill = document.createElement('span');
        fill.className = 'fill';
        fill.textContent = word;

        span.appendChild(fill);
        container.appendChild(span);
    });
}

// Each word's [start, end] on the video timeline. Real per-word caption
// timing when we have it, otherwise the line's duration spread evenly over
// its characters — which is only ever an approximation, since it assumes
// every word is held for as long as it is long.
function computeWordBounds(wordElements, lineStart, lineEnd, wordStarts) {
    // One entry per word, plus the closing boundary of the final word.
    if (wordStarts && wordStarts.length === wordElements.length + 1) {
        return Array.from(wordElements, (el, i) => ({
            start: wordStarts[i],
            end: wordStarts[i + 1],
        }));
    }

    const lineDuration = lineEnd - lineStart;
    const lengths = Array.from(wordElements, el => el.childNodes[0].textContent.length);
    const totalChars = lengths.reduce((sum, length) => sum + length, 0);
    if (totalChars === 0) return null;

    let charsSoFar = 0;
    return lengths.map((length) => {
        const start = lineStart + (charsSoFar / totalChars) * lineDuration;
        charsSoFar += length;
        return { start, end: lineStart + (charsSoFar / totalChars) * lineDuration };
    });
}

function updateFill(container, currentTime, lineStart, lineEnd, wordStarts) {
    const wordElements = container.querySelectorAll('.lyrics-word');
    if (wordElements.length === 0) return;

    const bounds = computeWordBounds(wordElements, lineStart, lineEnd, wordStarts);
    if (!bounds) return;

    wordElements.forEach((wordEl, i) => {
        const fillEl = wordEl.querySelector('.fill');
        const { start, end } = bounds[i];

        if (currentTime >= end) {
            // Fully sung
            fillEl.style.width = '100%';
            wordEl.classList.add('sung');
        } else if (currentTime <= start) {
            // Not yet
            fillEl.style.width = '0%';
            wordEl.classList.remove('sung');
        } else {
            // Partially filling
            const pct = Math.min(100, Math.max(0, ((currentTime - start) / (end - start)) * 100));
            fillEl.style.width = pct + '%';
            wordEl.classList.remove('sung');
        }
    });
}

function clearLyricsDisplay() {
    lyricsPrev.textContent = '';
    lyricsCurrent.innerHTML = '';
    lyricsNext.textContent = '';
    state.currentLineIndex = -1;
    state.renderKey = null;
}

// ═══════════════════════════════════════════
//  Controls
// ═══════════════════════════════════════════

function setSyncOffset(offset) {
    state.syncOffset = offset;
    if (offset < parseFloat(offsetSlider.min)) offsetSlider.min = Math.floor(offset - 5);
    if (offset > parseFloat(offsetSlider.max)) offsetSlider.max = Math.ceil(offset + 5);
    offsetSlider.value = offset;
    offsetValue.textContent = offset.toFixed(1) + 's';
    // Force re-render
    state.renderKey = null;
}

offsetSlider.addEventListener('input', () => {
    setSyncOffset(parseFloat(offsetSlider.value));
});

tapSyncBtn.addEventListener('click', () => {
    if (!state.player || !state.playerReady || state.lineTimes.length === 0) return;

    const videoTime = state.player.getCurrentTime();
    const firstLineStart = state.lineTimes[0].start;
    setSyncOffset(firstLineStart - videoTime);

    tapSyncBtn.textContent = 'Synced!';
    setTimeout(() => { tapSyncBtn.textContent = tapSyncDefaultText; }, 1000);
});

// ═══════════════════════════════════════════
//  Transport controls
// ═══════════════════════════════════════════

// The bar is driven off a timer rather than the lyrics loop, because it has to
// keep showing the truth while paused, buffering and seeking too.
const TRANSPORT_TICK = 200;
const IDLE_HIDE_DELAY = 2600;
let transportTimer = null;
let idleTimer = null;
let scrubbing = false;

function playerReady() {
    return !!(state.player && state.playerReady);
}

function setPlayIcon(playing) {
    playBtn.textContent = playing ? '⏸' : '▶';
}

function renderTransport() {
    if (!playerReady()) return;
    const duration = state.player.getDuration() || 0;
    timeTotal.textContent = duration ? formatTime(duration) : '0:00';

    if (!scrubbing) {
        const current = state.player.getCurrentTime() || 0;
        const fraction = duration ? Math.min(1, current / duration) : 0;
        seekPlayed.style.width = `${fraction * 100}%`;
        seekHandle.style.left = `${fraction * 100}%`;
        timeCurrent.textContent = formatTime(current);
    }
    const buffered = state.player.getVideoLoadedFraction?.() || 0;
    seekBuffer.style.width = `${buffered * 100}%`;
}

function startTransport() {
    stopTransport();
    renderTransport();
    transportTimer = setInterval(renderTransport, TRANSPORT_TICK);
}

function stopTransport() {
    if (transportTimer) clearInterval(transportTimer);
    transportTimer = null;
}

function togglePlay() {
    if (!playerReady()) return;
    const playing = state.player.getPlayerState() === YT.PlayerState.PLAYING;
    if (playing) state.player.pauseVideo();
    else state.player.playVideo();
}

// Fade the bar out while the song plays, and bring it straight back on any
// pointer movement — a control bar sitting over the lyrics the whole time is
// exactly the clutter we removed YouTube's for.
function wakeControls() {
    stageEl.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (playerReady() && state.player.getPlayerState() === YT.PlayerState.PLAYING) {
            stageEl.classList.add('idle');
        }
    }, IDLE_HIDE_DELAY);
}

function seekFractionFromEvent(event) {
    const rect = seekEl.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
}

function previewSeek(fraction) {
    const duration = playerReady() ? state.player.getDuration() || 0 : 0;
    seekPlayed.style.width = `${fraction * 100}%`;
    seekHandle.style.left = `${fraction * 100}%`;
    timeCurrent.textContent = formatTime(fraction * duration);
}

seekEl.addEventListener('pointerdown', (e) => {
    if (!playerReady()) return;
    scrubbing = true;
    seekEl.classList.add('scrubbing');
    seekEl.setPointerCapture(e.pointerId);
    previewSeek(seekFractionFromEvent(e));
});

seekEl.addEventListener('pointermove', (e) => {
    if (scrubbing) previewSeek(seekFractionFromEvent(e));
    wakeControls();
});

seekEl.addEventListener('pointerup', (e) => {
    if (!scrubbing) return;
    const fraction = seekFractionFromEvent(e);
    scrubbing = false;
    seekEl.classList.remove('scrubbing');
    if (playerReady()) {
        state.player.seekTo(fraction * (state.player.getDuration() || 0), true);
        // The line on screen belongs to the old position.
        state.renderKey = null;
    }
});

playBtn.addEventListener('click', togglePlay);
clickLayer.addEventListener('click', togglePlay);

function volumeIcon(volume, muted) {
    if (muted || volume === 0) return '🔇';
    return volume < 50 ? '🔉' : '🔊';
}

// The player applies volume and mute a moment after being told to, so reading
// the values straight back gives the *previous* ones — doing that would snap
// the slider back to where it was as soon as you moved it. The controls show
// what was asked for; renderVolume only reconciles at points where nothing is
// mid-interaction.
muteBtn.addEventListener('click', () => {
    if (!playerReady()) return;
    const muted = !state.player.isMuted();
    if (muted) {
        state.player.mute();
        volumeSlider.value = 0;
    } else {
        state.player.unMute();
        const restored = Math.round(state.player.getVolume()) || 60;
        state.player.setVolume(restored);
        volumeSlider.value = restored;
    }
    muteBtn.textContent = volumeIcon(parseInt(volumeSlider.value, 10), muted);
});

volumeSlider.addEventListener('input', () => {
    if (!playerReady()) return;
    const value = parseInt(volumeSlider.value, 10);
    state.player.setVolume(value);
    if (value === 0) state.player.mute();
    else if (state.player.isMuted()) state.player.unMute();
    muteBtn.textContent = volumeIcon(value, value === 0);
});

function renderVolume() {
    if (!playerReady()) return;
    const muted = state.player.isMuted();
    const volume = muted ? 0 : Math.round(state.player.getVolume());
    volumeSlider.value = volume;
    muteBtn.textContent = volumeIcon(volume, muted);
}

stageEl.addEventListener('pointermove', wakeControls);
stageEl.addEventListener('pointerleave', () => {
    if (playerReady() && state.player.getPlayerState() === YT.PlayerState.PLAYING) {
        stageEl.classList.add('idle');
    }
});

// Space and arrows are the shortcuts anyone expects from a video; the iframe
// has keyboard control disabled so they would otherwise do nothing.
document.addEventListener('keydown', (e) => {
    if (playerScreen.classList.contains('hidden')) return;
    // Not every event target is an Element — document has no .matches — and
    // throwing here would take the whole shortcut handler down with it.
    if (e.target instanceof Element && e.target.matches('input, textarea')) return;
    if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        togglePlay();
        wakeControls();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (!playerReady()) return;
        e.preventDefault();
        const step = e.key === 'ArrowRight' ? 5 : -5;
        state.player.seekTo(Math.max(0, state.player.getCurrentTime() + step), true);
        state.renderKey = null;
        wakeControls();
    } else if (e.key === 'f') {
        fullscreenBtn.click();
    }
});

fullscreenBtn.addEventListener('click', () => {
    // Fullscreen the whole stage (video + lyrics overlay), not just the
    // YouTube iframe, so the lyrics stay visible in fullscreen.
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else if (stageEl.requestFullscreen) {
        stageEl.requestFullscreen();
    } else if (stageEl.webkitRequestFullscreen) {
        stageEl.webkitRequestFullscreen();
    }
});

backBtn.addEventListener('click', () => {
    stopLyricsLoop();
    stopTransport();
    stageEl.classList.remove('idle');
    clearTimeout(idleTimer);
    if (state.player && state.playerReady) {
        state.player.stopVideo();
    }
    state.lyrics = [];
    state.currentVideoId = null;
    setSyncStatus('');
    clearLyricsDisplay();
    playerScreen.classList.add('hidden');
    searchScreen.classList.remove('hidden');
});

// ═══════════════════════════════════════════
//  Utilities
// ═══════════════════════════════════════════

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
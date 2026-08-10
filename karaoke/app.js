// ═══════════════════════════════════════════
//  State
// ═══════════════════════════════════════════

const state = {
    apiReady: false,
    player: null,
    playerReady: false,
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

function ensurePlayer(videoId) {
    if (state.player && state.playerReady) {
        console.log('[karaoke] ensurePlayer: player already ready, loading', videoId);
        state.player.loadVideoById(videoId);
        return;
    }
    if (state.player || !state.apiReady) {
        if (window.__youtubeApiScriptFailed) {
            console.error('[karaoke] The YouTube iframe_api script failed to load (network error). '
                + 'An ad blocker or browser extension is the most likely cause — try disabling it for this page.');
            alert('Could not load the YouTube player: the youtube.com script failed to load. '
                + 'This is usually an ad blocker or extension blocking youtube.com — try disabling it for this page.');
            apiReadyWaitStarted = null;
            return;
        }
        if (!state.apiReady) {
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
        console.log('[karaoke] ensurePlayer: waiting —', { hasPlayer: !!state.player, apiReady: state.apiReady });
        setTimeout(() => ensurePlayer(videoId), 200);
        return;
    }

    console.log('[karaoke] ensurePlayer: creating YT.Player for', videoId);
    state.player = new YT.Player('youtube-player', {
        height: '100%',
        width: '100%',
        playerVars: {
            autoplay: 0,
            controls: 1,
            rel: 0,
            modestbranding: 1,
            fs: 0, // YouTube's own fullscreen only fullscreens the iframe,
                   // which hides the lyrics overlay — use our own button instead
        },
        events: {
            onReady: () => {
                console.log('[karaoke] player onReady fired, loading', videoId);
                state.playerReady = true;
                state.player.loadVideoById(videoId);
            },
            onError: (e) => {
                console.error('[karaoke] player onError:', e.data, YT_ERROR_MESSAGES[e.data] || 'unknown');
            },
            onStateChange: (e) => {
                if (e.data === YT.PlayerState.PLAYING) {
                    startLyricsLoop();
                } else {
                    stopLyricsLoop();
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

    const ytQuery = `${lrcItem.trackName} ${lrcItem.artistName} official music video`;
    let videoId;

    try {
        videoId = await searchYouTube(ytQuery);
    } catch (err) {
        console.error('YouTube search failed:', err);
        alert('Could not find a YouTube video for this song.');
        return;
    }

    if (!videoId) {
        alert('No YouTube video found.');
        return;
    }

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

async function searchYouTube(query) {
    // yt-dlp runs server-side (server.py's /api/search route) since it's a
    // Python library, not something the browser can call directly.
    const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
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

// For each lyric line, find the caption cue with the closest wording
// (highest word-overlap score) — this is pass 1, considered independently
// per line with no positional constraint yet.
function findBestCaptionMatches(lyrics, sortedCues, cueWordSets) {
    return lyrics.map((line) => {
        const lineWords = normalizeWords(line.text);
        const requiredScore = lineWords.size <= SHORT_LINE_WORD_COUNT
            ? SHORT_LINE_MIN_SCORE
            : MIN_CAPTION_MATCH_SCORE;

        let bestIdx = -1;
        let bestScore = 0;
        for (let c = 0; c < sortedCues.length; c++) {
            const score = wordOverlapScore(lineWords, cueWordSets[c]);
            if (score > bestScore) {
                bestScore = score;
                bestIdx = c;
            }
        }
        return (bestIdx === -1 || bestScore < requiredScore) ? null : sortedCues[bestIdx];
    });
}

function alignLyricsToCaptions(lyrics, cues) {
    const sortedCues = [...cues].sort((a, b) => a.start - b.start);
    const cueWordSets = sortedCues.map(c => normalizeWords(c.text));
    const candidates = findBestCaptionMatches(lyrics, sortedCues, cueWordSets);

    // Pass 2: reject outliers whose implied offset from the LRC's own
    // timing is way off from the rest — catches the false-positive case
    // above without needing to know in advance which line it'll hit.
    const offsets = [];
    candidates.forEach((c, i) => { if (c) offsets.push(c.start - lyrics[i].time); });
    if (offsets.length === 0) return new Array(lyrics.length).fill(null);
    offsets.sort((a, b) => a - b);
    const medianOffset = offsets[Math.floor(offsets.length / 2)];

    // Pass 3: enforce chronological order on what survives — a match that
    // jumps backwards relative to the previous accepted one is more likely
    // a false positive than a real reordering.
    const aligned = new Array(lyrics.length).fill(null);
    let lastStart = -Infinity;
    candidates.forEach((cue, i) => {
        if (!cue) return;
        if (Math.abs((cue.start - lyrics[i].time) - medianOffset) > OFFSET_OUTLIER_TOLERANCE) return;
        if (cue.start < lastStart) return;
        aligned[i] = { start: cue.start, end: cue.end };
        lastStart = cue.start;
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

async function alignToCaptions(videoId) {
    let cues;
    try {
        const resp = await fetch(`/api/captions?v=${encodeURIComponent(videoId)}`);
        if (!resp.ok) return;
        const data = await resp.json();
        cues = data.cues;
    } catch (err) {
        console.warn('Caption fetch failed:', err);
        return;
    }
    if (!cues || cues.length === 0) return;

    const lineTimes = computeLineTimesFromCaptions(state.lyrics, cues);
    if (!lineTimes) return; // nothing matched with enough confidence

    state.lineTimes = lineTimes;
    state.renderKey = null; // force re-render with the refined timings

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

        // Instrumental gap is measured to the *next line's start*, decoupled
        // from this line's own (usually much shorter) natural end — a caption
        // match means lineNaturalEnd no longer stretches across the gap.
        const gapDuration = nextLineStart - lineStart;
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
        updateFill(lyricsCurrent, currentTime, lineStart, lineNaturalEnd);
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
    const words = text.split(/\s+/);
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

function updateFill(container, currentTime, lineStart, lineEnd) {
    const wordElements = container.querySelectorAll('.lyrics-word');
    if (wordElements.length === 0) return;

    const lineDuration = lineEnd - lineStart;
    const elapsed = currentTime - lineStart;
    const totalChars = Array.from(wordElements).reduce((sum, el) => {
        // Get text content minus the fill span duplicate
        return sum + el.childNodes[0].textContent.length;
    }, 0);

    if (totalChars === 0) return;

    let charsSoFar = 0;

    wordElements.forEach((wordEl) => {
        const fillEl = wordEl.querySelector('.fill');
        const wordText = wordEl.childNodes[0].textContent;
        const wordLen = wordText.length;

        const wordCharStart = charsSoFar;
        const wordCharEnd = charsSoFar + wordLen;
        charsSoFar += wordLen;

        // Calculate time range for this word (linear interpolation by character position)
        const wordTimeStart = lineStart + (wordCharStart / totalChars) * lineDuration;
        const wordTimeEnd = lineStart + (wordCharEnd / totalChars) * lineDuration;

        if (currentTime >= wordTimeEnd) {
            // Fully sung
            fillEl.style.width = '100%';
            wordEl.classList.add('sung');
        } else if (currentTime <= wordTimeStart) {
            // Not yet
            fillEl.style.width = '0%';
            wordEl.classList.remove('sung');
        } else {
            // Partially filling
            const wordDuration = wordTimeEnd - wordTimeStart;
            const wordElapsed = currentTime - wordTimeStart;
            const pct = Math.min(100, Math.max(0, (wordElapsed / wordDuration) * 100));
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
    if (state.player && state.playerReady) {
        state.player.stopVideo();
    }
    state.lyrics = [];
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
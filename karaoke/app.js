// ═══════════════════════════════════════════
//  State
// ═══════════════════════════════════════════

const state = {
    apiReady: false,
    player: null,
    playerReady: false,
    lyrics: [],         // [{time: seconds, text: "..."}, ...]
    currentLineIndex: -1,
    renderKey: null,    // tracks what's on screen so we only re-render on change
    syncOffset: 0,
    animFrameId: null,
};

// A gap to the next line longer than this is treated as an instrumental
// break; INSTRUMENTAL_HOLD is how long the just-sung line stays on screen
// before the display switches to the instrumental indicator.
const INSTRUMENTAL_GAP_THRESHOLD = 8;
const INSTRUMENTAL_HOLD = 5;

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

function ensurePlayer(videoId) {
    if (state.player && state.playerReady) {
        console.log('[karaoke] ensurePlayer: player already ready, loading', videoId);
        state.player.loadVideoById(videoId);
        return;
    }
    if (state.player || !state.apiReady) {
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
    // Parse synced lyrics
    state.lyrics = parseLRC(lrcItem.syncedLyrics);
    state.currentLineIndex = -1;

    // Find YouTube video. Pass the first lyric line along so the server can
    // try to auto-detect the sync offset from the video's own captions.
    const ytQuery = `${lrcItem.trackName} ${lrcItem.artistName} official music video`;
    let videoId, suggestedOffset;

    try {
        ({ videoId, suggestedOffset } = await searchYouTube(ytQuery, state.lyrics[0]));
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

    // Reset offset, applying an auto-detected one if captions gave us one
    offsetSlider.min = -30;
    offsetSlider.max = 30;
    setSyncOffset(Number.isFinite(suggestedOffset) ? suggestedOffset : 0);
    if (Number.isFinite(suggestedOffset)) {
        tapSyncBtn.textContent = 'Auto-synced from captions!';
        setTimeout(() => { tapSyncBtn.textContent = tapSyncDefaultText; }, 2000);
    }

    // Clear lyrics display
    clearLyricsDisplay();

    // Load video. #player-screen is visible by this point (see above),
    // so it's now safe for ensurePlayer to create the YouTube iframe.
    ensurePlayer(videoId);
}

async function searchYouTube(query, firstLine) {
    // Piped's public mirrors don't reliably allow direct browser (CORS)
    // access, so the search (and caption-based offset lookup) run
    // server-side via server.py's /api/search route.
    const params = new URLSearchParams({ q: query });
    if (firstLine) {
        params.set('first_line', firstLine.text);
        params.set('first_line_time', firstLine.time);
    }

    const resp = await fetch(`/api/search?${params.toString()}`);
    if (!resp.ok) throw new Error(`Search request failed: ${resp.status}`);

    const data = await resp.json();
    if (!data.url) return { videoId: null, suggestedOffset: null };

    // Extract video ID from URL like /watch?v=XXXXX
    const match = data.url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    return {
        videoId: match ? match[1] : null,
        suggestedOffset: typeof data.suggestedOffset === 'number' ? data.suggestedOffset : null,
    };
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

    // Find current line index
    let lineIndex = -1;
    for (let i = state.lyrics.length - 1; i >= 0; i--) {
        if (currentTime >= state.lyrics[i].time) {
            lineIndex = i;
            break;
        }
    }

    let isInstrumental = false;
    let lineStart = null;
    let lineEnd = null;
    if (lineIndex >= 0) {
        lineStart = state.lyrics[lineIndex].time;
        lineEnd = (lineIndex + 1 < state.lyrics.length)
            ? state.lyrics[lineIndex + 1].time
            : lineStart + 5; // assume 5 seconds for last line

        const gapDuration = lineEnd - lineStart;
        isInstrumental = gapDuration > INSTRUMENTAL_GAP_THRESHOLD
            && currentTime > lineStart + INSTRUMENTAL_HOLD;
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

    // Update fill animation on current line
    if (!isInstrumental && lineIndex >= 0 && lineIndex < state.lyrics.length) {
        updateFill(lyricsCurrent, currentTime, lineStart, lineEnd);
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
    if (!state.player || !state.playerReady || state.lyrics.length === 0) return;

    const videoTime = state.player.getCurrentTime();
    const firstLyricTime = state.lyrics[0].time;
    setSyncOffset(firstLyricTime - videoTime);

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
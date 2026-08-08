// ═══════════════════════════════════════════
//  State
// ═══════════════════════════════════════════

const state = {
    player: null,
    playerReady: false,
    lyrics: [],         // [{time: seconds, text: "..."}, ...]
    currentLineIndex: -1,
    syncOffset: 0,
    animFrameId: null,
};

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
const lyricsPrev = document.getElementById('lyrics-prev');
const lyricsCurrent = document.getElementById('lyrics-current');
const lyricsNext = document.getElementById('lyrics-next');

// ═══════════════════════════════════════════
//  YouTube IFrame API
// ═══════════════════════════════════════════

// YouTube API calls this global function when ready
window.onYouTubeIframeAPIReady = () => {
    state.player = new YT.Player('youtube-player', {
        height: '100%',
        width: '100%',
        playerVars: {
            autoplay: 0,
            controls: 1,
            rel: 0,
            modestbranding: 1,
        },
        events: {
            onReady: () => {
                state.playerReady = true;
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
};

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

    // Find YouTube video
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

    // Reset offset
    offsetSlider.value = 0;
    state.syncOffset = 0;
    offsetValue.textContent = '0.0s';

    // Clear lyrics display
    clearLyricsDisplay();

    // Load video
    if (state.playerReady) {
        state.player.loadVideoById(videoId);
    } else {
        // Wait for player to be ready
        const interval = setInterval(() => {
            if (state.playerReady) {
                clearInterval(interval);
                state.player.loadVideoById(videoId);
            }
        }, 200);
    }
}

async function searchYouTube(query) {
    // Piped's public mirrors don't reliably allow direct browser (CORS)
    // access, so the search runs server-side via server.py's /api/search
    // route and hands back just the video URL.
    const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!resp.ok) throw new Error(`Search request failed: ${resp.status}`);

    const data = await resp.json();
    if (!data.url) return null;

    // Extract video ID from URL like /watch?v=XXXXX
    const match = data.url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
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

    // Only re-render lines if the line changed
    if (lineIndex !== state.currentLineIndex) {
        state.currentLineIndex = lineIndex;
        renderLines(lineIndex);
    }

    // Update fill animation on current line
    if (lineIndex >= 0 && lineIndex < state.lyrics.length) {
        const lineStart = state.lyrics[lineIndex].time;
        const lineEnd = (lineIndex + 1 < state.lyrics.length)
            ? state.lyrics[lineIndex + 1].time
            : lineStart + 5; // assume 5 seconds for last line

        updateFill(lyricsCurrent, currentTime, lineStart, lineEnd);
    }
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
}

// ═══════════════════════════════════════════
//  Controls
// ═══════════════════════════════════════════

offsetSlider.addEventListener('input', () => {
    state.syncOffset = parseFloat(offsetSlider.value);
    offsetValue.textContent = state.syncOffset.toFixed(1) + 's';
    // Force re-render
    state.currentLineIndex = -2;
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
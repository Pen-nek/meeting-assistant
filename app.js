/**
 * meeting-assistant · app.js
 */
'use strict';

const BACKEND = 'http://localhost:8000';
const BATCH   = 60;

const COLORS = [
    { dot:'#a89cf9', cls:'speaker-0', bg:'rgba(124,106,247,.15)', border:'rgba(124,106,247,.3)' },
    { dot:'#f7c56a', cls:'speaker-1', bg:'rgba(247,197,106,.15)', border:'rgba(247,197,106,.3)' },
    { dot:'#5cf0b0', cls:'speaker-2', bg:'rgba(92,240,176,.15)',  border:'rgba(92,240,176,.3)'  },
    { dot:'#f75c6a', cls:'speaker-3', bg:'rgba(247,92,106,.15)',  border:'rgba(247,92,106,.3)'  },
    { dot:'#5bc8f5', cls:'speaker-4', bg:'rgba(91,200,245,.15)',  border:'rgba(91,200,245,.3)'  },
    { dot:'#f0a0d0', cls:'speaker-5', bg:'rgba(240,160,208,.15)', border:'rgba(240,160,208,.3)' },
];

const state = {
    file: null, result: null, tab: 'transcript',
    utterances: [], speakerNames: {},
    rendered: 0, loadingMore: false,
    autoScroll: true, scrollPaused: false, scrollTimer: null, lastScrollEl: null,
    stickyBar: null, stickyVisible: false,
    ctxTarget: null, cpDrag: false, activeItem: null,
};

// ── 유틸 ─────────────────────────────────────────
const $  = id  => document.getElementById(id);
const $$ = sel => [...document.querySelectorAll(sel)];
const color   = spk => COLORS[(spk - 1) % COLORS.length];
const spkName = spk => state.speakerNames[spk] ?? `발화자 ${spk}`;
const fmtSize = b => b < 1048576 ? `${(b/1024).toFixed(1)} KB` : `${(b/1048576).toFixed(1)} MB`;
const fmtTime = s => (!s || isNaN(s)) ? '00:00' : `${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s)%60).padStart(2,'0')}`;
const showErr = msg => { $('errorBox').textContent = msg; $('errorBox').classList.add('visible'); };
const hideErr = ()  => $('errorBox').classList.remove('visible');
const dlBlob  = (blob, name) => Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name }).click();
const getFullText = () => $$('.utterance-text').map(el => `[발화자 ${el.dataset.speaker}] ${el.innerText.trim()}`).join('\n');

// ── 파일 ─────────────────────────────────────────
const audioEl    = $('audioElResult');
const uploadArea = $('uploadArea');

function setFile(file) {
    state.file = file;
    $('fileName').textContent = file.name;
    $('fileSize').textContent = fmtSize(file.size);
    $('filePreview').classList.add('visible');
    $('submitBtn').disabled = false;
    audioEl.src = URL.createObjectURL(file);
}

uploadArea.addEventListener('click',    e => { e.stopPropagation(); $('fileInput').click(); });
uploadArea.addEventListener('dragover',  e => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
uploadArea.addEventListener('drop', e => {
    e.preventDefault(); uploadArea.classList.remove('drag-over');
    e.dataTransfer.files[0] && setFile(e.dataTransfer.files[0]);
});
$('fileInput').addEventListener('change', e => e.target.files[0] && setFile(e.target.files[0]));
$('removeFile').addEventListener('click', () => {
    state.file = null; $('fileInput').value = '';
    $('filePreview').classList.remove('visible');
    $('submitBtn').disabled = true;
});

// ── Steps / Progress ─────────────────────────────
function setStep(n) {
    for (let i = 1; i <= 3; i++) {
        $(`step${i}`).classList.toggle('done',   i < n);
        $(`step${i}`).classList.toggle('active', i === n);
        if (i > n) $(`step${i}`).classList.remove('done', 'active');
    }
}

const _stepTimers = {}, _stepStart = {};
function setProgStep(n) {
    for (let i = 1; i <= 5; i++) {
        const el = $(`prog${i}`); if (!el) continue;
        const wasActive = el.classList.contains('active');
        el.classList.toggle('done',   i < n);
        el.classList.toggle('active', i === n);
        if (i > n) el.classList.remove('done', 'active');
        if (i === n && !wasActive) _startElapsed(i);
        if (i < n) _stopElapsed(i);
    }
}
function _startElapsed(n) {
    if (_stepTimers[n]) return;
    _stepStart[n] = Date.now();
    const el = $(`elapsed${n}`); if (el) el.textContent = '0s';
    _stepTimers[n] = setInterval(() => {
        const el = $(`elapsed${n}`);
        if (el) el.textContent = Math.floor((Date.now() - _stepStart[n]) / 1000) + 's';
    }, 1000);
}
function _stopElapsed(n) {
    if (!_stepTimers[n]) return;
    clearInterval(_stepTimers[n]); delete _stepTimers[n];
    const el = $(`elapsed${n}`);
    if (el && _stepStart[n]) el.textContent = Math.floor((Date.now() - _stepStart[n]) / 1000) + 's';
}

// ── 탭 ───────────────────────────────────────────
function switchTab(name) {
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + name));
    state.tab = name;
    updateFab();
}
$$('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
switchTab('transcript');

// ── 탭 맨 위로 스크롤 ────────────────────────────
function scrollTabTop() {
    const title = $('tab-' + state.tab)?.querySelector('.tab-section-title');
    (title || document.body).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── 드래그 정렬 ──────────────────────────────────
let dragSrc = null;
function addDragEvents(el) {
    el.addEventListener('dragstart', e => {
        dragSrc = el; e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => el.classList.add('drag-ghost'), 0);
    });
    el.addEventListener('dragend', () => {
        el.classList.remove('drag-ghost');
        el.parentNode?.querySelectorAll('.drag-over-top,.drag-over-bot').forEach(n => n.classList.remove('drag-over-top', 'drag-over-bot'));
        dragSrc = null;
    });
    el.addEventListener('dragover', e => {
        if (!dragSrc || dragSrc === el) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        const after = e.clientY > el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2;
        el.parentNode?.querySelectorAll('.drag-over-top,.drag-over-bot').forEach(n => n.classList.remove('drag-over-top', 'drag-over-bot'));
        el.classList.add(after ? 'drag-over-bot' : 'drag-over-top');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over-top', 'drag-over-bot'));
    el.addEventListener('drop', e => {
        if (!dragSrc || dragSrc === el) return;
        e.preventDefault();
        const after = e.clientY > el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2;
        el.classList.remove('drag-over-top', 'drag-over-bot');
        after ? el.after(dragSrc) : el.before(dragSrc);
        if (el.closest('#minutesContent')) syncMinutes();
        if (el.closest('#todoContent'))    syncTodosFromDOM();
    });
}

function syncTodosFromDOM() {
    if (!state.result) return;
    state.result.todos = $$('#todoContent .todo-item').map(li => {
        const task = li.querySelector('.todo-task')?.innerText.trim();
        return state.result.todos.find(t => t.task === task);
    }).filter(Boolean);
}

// ── 오디오 플레이어 ──────────────────────────────
function setupPlayer() {
    audioEl.addEventListener('timeupdate', onTick);
    const syncDur = () => {
        if (audioEl.duration && !isNaN(audioEl.duration)) {
            $('cpTimeDur').textContent = fmtTime(audioEl.duration);
            if ($('stickyTimeDur')) $('stickyTimeDur').textContent = fmtTime(audioEl.duration);
        }
    };
    syncDur();
    audioEl.addEventListener('loadedmetadata', syncDur);
    audioEl.addEventListener('play',  () => { togglePlayIcon(false); syncPlayBtn(); });
    audioEl.addEventListener('pause', () => { togglePlayIcon(true);  syncPlayBtn(); });
    $('cpPlay').addEventListener('click', () => audioEl.paused ? audioEl.play() : audioEl.pause());

    // 트랙 드래그
    const track = $('cpTrack');
    const seek = x => { const r = track.getBoundingClientRect(); audioEl.currentTime = Math.max(0, Math.min(1, (x - r.left) / r.width)) * (audioEl.duration || 0); };
    track.addEventListener('mousedown',  e => { state.cpDrag = true; track.classList.add('dragging'); seek(e.clientX); });
    track.addEventListener('touchstart', e => { state.cpDrag = true; track.classList.add('dragging'); seek(e.touches[0].clientX); }, { passive: true });
    document.addEventListener('mousemove',  e => { if (state.cpDrag) seek(e.clientX); });
    document.addEventListener('touchmove',  e => { if (state.cpDrag) seek(e.touches[0].clientX); }, { passive: true });
    document.addEventListener('mouseup',  () => { state.cpDrag = false; track.classList.remove('dragging'); });
    document.addEventListener('touchend', () => { state.cpDrag = false; track.classList.remove('dragging'); });

    $('cpVolBtn').addEventListener('click', () => { audioEl.muted = !audioEl.muted; $('cpVolSlider').value = audioEl.muted ? 0 : audioEl.volume; syncVolIcon(); });
    $('cpVolSlider').addEventListener('input', e => { audioEl.volume = +e.target.value; audioEl.muted = audioEl.volume === 0; syncVolIcon(); });
    setupRateMenu('cpRateBtn', 'cpRateMenu');
}

function setupRateMenu(btnId, menuId) {
    const btn = $(btnId), menu = $(menuId); if (!btn || !menu) return;
    btn.addEventListener('click', e => { e.stopPropagation(); const opening = menu.classList.toggle('open'); if (opening) menu.classList.toggle('drop-down', btn.getBoundingClientRect().top < 180); });
    document.addEventListener('click', () => menu.classList.remove('open'));
    menu.querySelectorAll('button[data-rate]').forEach(b => {
        b.addEventListener('click', e => {
            e.stopPropagation();
            const r = +b.dataset.rate; audioEl.playbackRate = r;
            $$('.cp-rate-btn, .sticky-rate-btn').forEach(el => el.textContent = r + '×');
            $$('.cp-rate-menu button, .sticky-rate-menu button').forEach(el => el.classList.remove('active'));
            $$(`[data-rate="${r}"]`).forEach(el => el.classList.add('active'));
            menu.classList.remove('open');
        });
    });
}

function togglePlayIcon(paused) {
    $('cpPlay').querySelector('.cp-icon-play').style.display  = paused ? '' : 'none';
    $('cpPlay').querySelector('.cp-icon-pause').style.display = paused ? 'none' : '';
    if ($('stickyPlayBtn')) $('stickyPlayBtn').textContent = paused ? '▶' : '⏸';
}

function syncVolIcon(prefix = 'cp') {
    const w1 = $(`${prefix}VolWave1`), w2 = $(`${prefix}VolWave2`); if (!w1) return;
    const v = audioEl.muted ? 0 : audioEl.volume;
    w1.style.display = v > 0   ? '' : 'none';
    w2.style.display = v > 0.5 ? '' : 'none';
}

function syncPlayBtn() {
    const playing = !audioEl.paused;
    if (state.activeItem) {
        state.activeItem.classList.toggle('playing', playing);
        const btn = state.activeItem.querySelector('.play-btn');
        if (btn) { btn.classList.toggle('playing', playing); btn.textContent = playing ? '⏸' : '▶'; }
    }
}

function onTick() {
    const cur = audioEl.currentTime, dur = audioEl.duration || 1;
    const pct = (cur / dur) * 100;
    const fill = $('cpFill'), thumb = $('cpThumb'), timeCur = $('cpTimeCur');
    if (fill)    fill.style.width    = pct + '%';
    if (thumb)   thumb.style.left   = pct + '%';
    if (timeCur) timeCur.textContent = fmtTime(cur);
    if (state.stickyVisible) {
        const sf = $('stickyFill'), st = $('stickyThumb'), sc = $('stickyTimeCur');
        if (sf) sf.style.width  = pct + '%';
        if (st) st.style.left   = pct + '%';
        if (sc) sc.textContent  = fmtTime(cur);
    }
    const hit = getUtteranceAtTime(cur);
    if (hit !== state.activeItem) {
        if (state.activeItem) {
            state.activeItem.classList.remove('playing');
            const b = state.activeItem.querySelector('.play-btn');
            if (b) { b.classList.remove('playing'); b.textContent = '▶'; }
        }
        state.activeItem = hit;
        if (hit && !audioEl.paused) {
            hit.classList.add('playing');
            const b = hit.querySelector('.play-btn');
            if (b) { b.classList.add('playing'); b.textContent = '⏸'; }
        }
    }
    if (!audioEl.paused && state.tab === 'transcript' && state.autoScroll) trackScroll(cur);
}

// ── Sticky Bar ─────────────────────────────────
function createStickyBar() {
    if (state.stickyBar) return;
    const bar = document.createElement('div');
    bar.id = 'stickyAudioBar';
    bar.innerHTML = `
    <div class="sticky-bar-inner">
      <button class="sticky-play-btn" id="stickyPlayBtn">▶</button>
      <span class="sticky-time-cur" id="stickyTimeCur">00:00</span>
      <div class="sticky-track" id="stickyTrack">
        <div class="sticky-fill"  id="stickyFill"></div>
        <div class="sticky-thumb" id="stickyThumb"></div>
      </div>
      <span class="sticky-time-dur" id="stickyTimeDur">${fmtTime(audioEl.duration)}</span>
      <div class="sticky-controls">
        <div class="cp-vol-wrap">
          <button class="cp-vol-btn sticky-vol-btn" id="stickyVolBtn" title="음소거">
            <svg viewBox="0 0 16 16"><path d="M2 5h3l4-3v12l-4-3H2V5z"/>
              <path id="stickyVolWave1" d="M11 4.5a5 5 0 0 1 0 7"/>
              <path id="stickyVolWave2" d="M12.5 2.5a8 8 0 0 1 0 11"/>
            </svg>
          </button>
          <div class="cp-vol-slider-wrap" id="stickyVolSliderWrap">
            <input class="cp-vol-slider" id="stickyVolSlider" type="range" min="0" max="1" step="0.02" value="${audioEl.volume}" />
          </div>
        </div>
        <div class="cp-rate-wrap">
          <button class="cp-rate-btn sticky-rate-btn" id="stickyRateBtn">${audioEl.playbackRate}×</button>
          <div class="cp-rate-menu sticky-rate-menu" id="stickyRateMenu">
            ${[0.5, 0.75, 1, 1.25, 1.5, 2].map(r => `<button data-rate="${r}" class="${r === audioEl.playbackRate ? 'active' : ''}">${r}×</button>`).join('')}
          </div>
        </div>
      </div>
    </div>`;
    document.body.appendChild(bar);
    state.stickyBar = bar;

    $('stickyPlayBtn').addEventListener('click', () => audioEl.paused ? audioEl.play() : audioEl.pause());

    const st = $('stickyTrack'); let sd = false;
    const ss = x => { const r = st.getBoundingClientRect(); const t = Math.max(0, Math.min(1, (x - r.left) / r.width)) * (audioEl.duration || 0); audioEl.currentTime = t; seekScrollToTime(t); };
    st.addEventListener('mousedown',  e => { sd = true; ss(e.clientX); });
    st.addEventListener('touchstart', e => { sd = true; ss(e.touches[0].clientX); }, { passive: true });
    document.addEventListener('mousemove',  e => { if (sd) ss(e.clientX); });
    document.addEventListener('touchmove',  e => { if (sd) ss(e.touches[0].clientX); }, { passive: true });
    document.addEventListener('mouseup',  () => { sd = false; });
    document.addEventListener('touchend', () => { sd = false; });

    $('stickyVolBtn').addEventListener('click', () => { audioEl.muted = !audioEl.muted; $('stickyVolSlider').value = audioEl.muted ? 0 : audioEl.volume; syncVolIcon('sticky'); syncVolIcon(); });
    $('stickyVolSlider').addEventListener('input', e => { audioEl.volume = +e.target.value; audioEl.muted = audioEl.volume === 0; $('cpVolSlider').value = e.target.value; syncVolIcon('sticky'); syncVolIcon(); });
    setupRateMenu('stickyRateBtn', 'stickyRateMenu');
    syncVolIcon('sticky');
}

function seekScrollToTime(t) {
    const target = getUtteranceAtTime(t);
    if (target) { state.scrollPaused = true; target.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => { state.scrollPaused = false; }, 800); }
}

function trackScroll(cur) {
    const target = getUtteranceAtTime(cur);
    if (!target || target === state.lastScrollEl) return;
    state.lastScrollEl = target; state.scrollPaused = true;
    getScrollAnchor(target).scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => { state.scrollPaused = false; }, 800);
}

function getScrollAnchor(el) {
    if (window.innerWidth < 768) return el;
    const prev = el.previousElementSibling;
    if (prev?.classList.contains('utterance-item')) return prev;
    return el.closest('.speaker-group')?.querySelector('.speaker-group-header') ?? el;
}

function getUtteranceAtTime(cur) {
    const items = $$('.utterance-item'); if (!items.length) return null;
    let lo = 0, hi = items.length - 1, result = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (parseFloat(items[mid].dataset.start) <= cur) { result = items[mid]; lo = mid + 1; } else hi = mid - 1; }
    return result;
}

// ── FAB ──────────────────────────────────────────
function updateFab() {
    if (!state.result) return;
    $('fabGroup').classList.add('visible');
    const isTranscript = state.tab === 'transcript';
    $('fabSave').classList.toggle('hidden', !isTranscript);
    $('fabWordReplace').classList.toggle('hidden', !isTranscript);
    $('fabTop').title = { transcript: '전체 대화 맨 위로', minutes: '회의록 맨 위로', todos: 'TO DO 맨 위로' }[state.tab] ?? '맨 위로';
}
$('fabTop').addEventListener('click',  scrollTabTop);
$('fabSave').addEventListener('click', () => $('regenBtn').click());
$('fabWordReplace').addEventListener('click', openWordReplaceModal);

window.addEventListener('scroll', () => {
    if (!state.result) return;
    const y = window.scrollY;
    $('fabGroup').classList.toggle('visible', y > 200);
    if (y > 200) updateFab();

    const audioBottom = $('audioPlayerResult').getBoundingClientRect().bottom;
    if (audioBottom < 0 && !state.stickyVisible) {
        createStickyBar(); state.stickyBar.classList.add('visible'); state.stickyVisible = true;
    } else if (audioBottom >= 0 && state.stickyVisible) {
        state.stickyBar?.classList.remove('visible'); state.stickyVisible = false;
    }

    if (state.tab === 'transcript' && document.documentElement.scrollHeight - innerHeight - y < 400) appendMore();
    if (!state.scrollPaused && !audioEl.paused && state.tab === 'transcript') {
        state.autoScroll = false;
        clearTimeout(state.scrollTimer);
        state.scrollTimer = setTimeout(() => { state.autoScroll = true; }, 2500);
    }
}, { passive: true });

// ── 발화자 패널 ──────────────────────────────────
function buildSpeakerPanel(utterances) {
    const grid = $('speakerListGrid'); grid.innerHTML = '';
    const speakers = [...new Set([...utterances.map(u => u.speaker + 1), ...Object.keys(state.speakerNames).map(Number)])].sort((a, b) => a - b);
    const best = pickBest(utterances);
    speakers.forEach(spk => {
        const c = color(spk);
        const card = document.createElement('div'); card.className = 'speaker-card';
        card.innerHTML = `<div class="speaker-card-dot" style="background:${c.dot}"></div><input class="speaker-card-name" value="${spkName(spk)}" data-spk="${spk}"><button class="speaker-card-play" data-spk="${spk}" title="미리듣기">▶</button>`;
        const inp = card.querySelector('.speaker-card-name');
        inp.addEventListener('blur',    () => { state.speakerNames[spk] = inp.value.trim() || spkName(spk); inp.value = state.speakerNames[spk]; refreshNames(); });
        inp.addEventListener('keydown', e => e.key === 'Enter' && inp.blur());
        const b = best[spk];
        card.querySelector('.speaker-card-play').addEventListener('click', () => b && previewSeg(b.start, b.end));
        grid.appendChild(card);
    });
    $('speakerListPanel').classList.add('visible');
}

function pickBest(utterances) {
    const res = {};
    utterances.forEach((u, i) => {
        const spk = u.speaker + 1, prev = utterances[i-1], next = utterances[i+1];
        const dur = (u.end || u.start + 2) - u.start;
        const clean = !(prev && u.start < (prev.end || prev.start + 1)) && !(next && (u.end || u.start + 2) > next.start);
        const score = (clean ? 30 : 0) + dur;
        if (!res[spk] || score > res[spk].score) res[spk] = { ...u, score };
    });
    return res;
}

let previewAudio = null;
function previewSeg(start, end) {
    if (!state.file) return;
    previewAudio?.pause();
    const a = new Audio(URL.createObjectURL(state.file));
    a.currentTime = start; a.play(); previewAudio = a;
    setTimeout(() => { if (previewAudio === a) { a.pause(); previewAudio = null; } }, Math.min((end ? end - start + 0.5 : 5), 10) * 1000);
}

function refreshNames() {
    $$('.speaker-group').forEach(g => { const lbl = g.querySelector('.speaker-label'); if (lbl) lbl.textContent = spkName(+g.dataset.speakerGroup); });
    $$('.speaker-card-name').forEach(inp => inp.value = spkName(+inp.dataset.spk));
    if (state.result?.todos) renderTodos(state.result.todos);
}

// ── 발화자 관리 모달 ─────────────────────────────
$('spkManageBtn').addEventListener('click', () => { buildMergeBoxes(); $('modalBackdrop').classList.add('visible'); });
$('modalClose').addEventListener('click',   closeModal);
$('modalBackdrop').addEventListener('click', e => e.target === $('modalBackdrop') && closeModal());
function closeModal() { $('modalBackdrop').classList.remove('visible'); }

function buildMergeBoxes() {
    const c = $('mergeCheckboxes'); c.innerHTML = '';
    [...new Set(state.utterances.map(u => u.speaker + 1))].sort((a, b) => a - b).forEach(spk => {
        const col = color(spk), el = document.createElement('div');
        el.className = 'merge-check-item'; el.dataset.spk = spk;
        el.innerHTML = `<div class="mci-dot" style="background:${col.dot}"></div><span class="mci-name">${spkName(spk)}</span>`;
        el.addEventListener('click', () => el.classList.toggle('selected'));
        c.appendChild(el);
    });
}

$('mergeBtn').addEventListener('click', () => {
    const sel = $$('.merge-check-item.selected').map(el => +el.dataset.spk);
    if (sel.length < 2) { alert('2명 이상 선택해주세요.'); return; }
    const name = $('mergeNameInput').value.trim() || spkName(sel[0]), tgt = sel[0];
    state.utterances = state.utterances.map(u => sel.includes(u.speaker + 1) ? { ...u, speaker: tgt - 1 } : u);
    state.speakerNames[tgt] = name; sel.slice(1).forEach(s => delete state.speakerNames[s]);
    renderTranscript(state.utterances); buildSpeakerPanel(state.utterances);
    if (state.result?.todos) renderTodos(state.result.todos);
    $('mergeNameInput').value = ''; closeModal();
});

$('addSpkBtn').addEventListener('click', () => {
    const name = $('addSpkInput').value.trim(); if (!name) return;
    const existing = state.utterances.length ? [...new Set(state.utterances.map(u => u.speaker + 1))] : Object.keys(state.speakerNames).map(Number);
    const newSpk = existing.length ? Math.max(...existing) + 1 : 1;
    state.speakerNames[newSpk] = name; buildSpeakerPanel(state.utterances);
    $('addSpkInput').value = ''; closeModal();
});

// ── 대화 렌더 (가상 스크롤) ──────────────────────
function renderTranscript(utterances) {
    state.utterances = utterances; state.rendered = 0; state.lastScrollEl = null; state.activeItem = null;
    $('transcriptContent').innerHTML = '';
    const n = Math.min(BATCH, utterances.length);
    renderBatch(0, n); state.rendered = n;
    if (utterances.length > n) appendSentinel();
}

function appendMore() {
    if (state.loadingMore || state.rendered >= state.utterances.length) return;
    state.loadingMore = true;
    const next = Math.min(state.rendered + BATCH, state.utterances.length);
    renderBatch(state.rendered, next); state.rendered = next;
    if (state.rendered < state.utterances.length) appendSentinel();
    state.loadingMore = false;
}

function appendSentinel() {
    const s = Object.assign(document.createElement('div'), { id: 'virtualSentinel' });
    s.style.height = '1px'; $('transcriptContent').appendChild(s);
}

function renderBatch(from, to) {
    $('virtualSentinel')?.remove();
    const content = $('transcriptContent');
    const seenSpk = new Set($$('.speaker-group[data-speaker-group]').map(el => +el.dataset.speakerGroup));
    state.utterances.slice(from, to).forEach((u, li) => {
        const spk = u.speaker + 1, gi = from + li;
        const lastEl = content.lastElementChild;
        if (lastEl && +lastEl.dataset.speakerGroup === spk) {
            lastEl.appendChild(buildUtteranceEl(u, spk, gi));
        } else {
            const c = color(spk), grp = document.createElement('div');
            grp.className = 'speaker-group'; grp.dataset.speakerGroup = spk;
            if (!seenSpk.has(spk)) { grp.id = `spk-first-${spk}`; seenSpk.add(spk); }
            grp.innerHTML = `<div class="speaker-group-header"><span class="speaker-label ${c.cls}">${spkName(spk)}</span></div>`;
            grp.appendChild(buildUtteranceEl(u, spk, gi));
            content.appendChild(grp);
        }
    });
}

function buildUtteranceEl(u, spk, idx) {
    const el = document.createElement('div');
    el.className = 'utterance-item';
    Object.assign(el.dataset, { start: u.start, end: u.end || 0, speaker: spk, utteranceIdx: idx });
    el.innerHTML = `
    <div class="utterance-meta">
      <span class="utterance-time">${fmtTime(u.start)}</span>
      <button class="play-btn" data-start="${u.start}">▶</button>
    </div>
    <div class="utterance-text" contenteditable="true" data-speaker="${spk}">${u.text}</div>`;
    el.querySelector('.play-btn').addEventListener('click', () => {
        if (state.activeItem === el && !audioEl.paused) { audioEl.pause(); return; }
        audioEl.currentTime = u.start; audioEl.play();
        state.autoScroll = true; state.lastScrollEl = null;
    });
    el.addEventListener('contextmenu', e => { e.preventDefault(); showCtx(e, el); });
    return el;
}

// ── 컨텍스트 메뉴 ────────────────────────────────
const ctxMenu = $('ctxMenu');
function showCtx(e, itemEl) {
    state.ctxTarget = itemEl;
    const cur = +itemEl.dataset.speaker;
    const speakers = [...new Set([...$$('.utterance-text').map(el => +el.dataset.speaker), ...Object.keys(state.speakerNames).map(Number)])].sort((a, b) => a - b);
    $('ctxSpeakers').innerHTML = '';
    speakers.forEach(spk => {
        const c = color(spk), btn = document.createElement('button');
        btn.className = 'ctx-spk-btn' + (spk === cur ? ' current' : '');
        btn.textContent = spkName(spk);
        btn.style.cssText = `background:${c.bg};color:${c.dot};border:1px solid ${c.border}`;
        btn.addEventListener('click', () => { changeSpk(itemEl, spk); hideCtx(); });
        $('ctxSpeakers').appendChild(btn);
    });
    ctxMenu.style.left = Math.min(e.clientX, innerWidth - 210) + 'px';
    ctxMenu.style.top  = Math.min(e.clientY, innerHeight - 100) + 'px';
    ctxMenu.classList.add('visible');
}
const hideCtx = () => { ctxMenu.classList.remove('visible'); state.ctxTarget = null; };
document.addEventListener('click', e => {
    if (!ctxMenu.contains(e.target)) hideCtx();
    if (!e.target.closest('.td-dropdown')) $$('.td-dropdown.open').forEach(d => d.classList.remove('open'));
});
document.addEventListener('keydown', e => e.key === 'Escape' && hideCtx());

function changeSpk(itemEl, newSpk) {
    if (+itemEl.dataset.speaker === newSpk) return;
    const idx = +itemEl.dataset.utteranceIdx;
    if (state.utterances[idx]) state.utterances[idx].speaker = newSpk - 1;
    const scrollY_ = window.scrollY;
    renderTranscript(state.utterances);
    window.scrollTo({ top: scrollY_, behavior: 'instant' });
}

// ── 회의록 렌더 ──────────────────────────────────
function makeMinutesRow(line) {
    const wrap = document.createElement('div'); wrap.className = 'minutes-row'; wrap.draggable = true;
    const handle = document.createElement('div'); handle.className = 'drag-handle'; handle.textContent = '⠿'; handle.title = '드래그해서 이동';
    const isH = line.startsWith('#');
    const el = document.createElement(isH ? 'h4' : 'p');
    el.textContent = line.replace(/^#+\s*/, ''); el.contentEditable = 'true';
    el.addEventListener('blur', syncMinutes);
    const del = document.createElement('button'); del.className = 'row-del-btn'; del.textContent = '✕'; del.title = '삭제';
    del.addEventListener('click', () => { if (!confirm('이 항목을 삭제할까요?')) return; wrap.remove(); syncMinutes(); });
    wrap.append(handle, el, del); addDragEvents(wrap);
    return wrap;
}

function renderMinutes(text) {
    const c = $('minutesContent'); c.innerHTML = '';
    text.split('\n').forEach(line => { if (line.trim()) c.appendChild(makeMinutesRow(line)); });
}

function syncMinutes() {
    if (!state.result) return;
    state.result.minutes = $$('#minutesContent .minutes-row').map(row => {
        const el = row.querySelector('h4,p'); if (!el) return '';
        return (el.tagName === 'H4' ? '## ' : '') + el.innerText.trim();
    }).filter(Boolean).join('\n');
}

$('addMinutesBtn').addEventListener('click', () => {
    const c = $('minutesContent'); c.querySelector('.minutes-add-form')?.remove();
    const form = document.createElement('div'); form.className = 'minutes-add-form';
    form.innerHTML = `<select class="custom-sel minutes-type-sel"><option value="p">일반 항목</option><option value="h">헤더 항목</option></select><input class="todo-add-input" placeholder="내용 입력..." /><button class="todo-add-confirm">추가</button><button class="todo-add-cancel">취소</button>`;
    c.appendChild(form); form.querySelector('input').focus();
    form.querySelector('.todo-add-confirm').addEventListener('click', () => {
        const text = form.querySelector('input').value.trim(); if (!text) return;
        form.replaceWith(makeMinutesRow(form.querySelector('select').value === 'h' ? `## ${text}` : text));
        syncMinutes();
    });
    form.querySelector('.todo-add-cancel').addEventListener('click', () => form.remove());
});

// ── TO DO 렌더 ───────────────────────────────────
function renderTodos(todos) {
    const c = $('todoContent'); c.innerHTML = '';
    state.result.todos = todos;
    const speakers = [...new Set($$('.utterance-text').map(el => +el.dataset.speaker).filter(n => !isNaN(n)))].sort((a, b) => a - b);
    const groups = [
        ...speakers.map(spk => ({ label: spkName(spk), cls: `speaker-label speaker-${(spk-1)%6} speaker-todo-label`, spk, todos: todos.filter(t => t.speaker !== null && t.speaker + 1 === spk) })),
        { label: '담당자 미정', style: 'background:rgba(107,107,130,.2);color:var(--muted);border:1px solid var(--border);padding:4px 12px;border-radius:20px;font-size:13px;font-weight:600', spk: null, todos: todos.filter(t => t.speaker == null) },
    ].filter(g => g.todos.length > 0);

    if (!groups.length) { c.innerHTML = '<p style="color:var(--muted);padding:16px 0">추출된 할 일이 없습니다.</p>'; return; }

    groups.forEach(g => {
        const div = document.createElement('div'); div.className = 'speaker-todo-group';
        div.innerHTML = `<div class="speaker-todo-header"><span class="${g.cls || 'speaker-todo-label'}" ${g.style ? `style="${g.style}"` : ''}>${g.label}</span><button class="group-del-btn" type="button">✕ 그룹 삭제</button></div>`;
        div.querySelector('.group-del-btn').addEventListener('click', () => {
            if (!confirm(`"${g.label}" 그룹의 할 일을 모두 삭제할까요?`)) return;
            state.result.todos = g.spk !== null
                ? state.result.todos.filter(t => !(t.speaker !== null && t.speaker + 1 === g.spk))
                : state.result.todos.filter(t => t.speaker !== null);
            renderTodos(state.result.todos);
        });
        const ul = document.createElement('ul'); ul.className = 'todo-list';
        g.todos.forEach(t => ul.appendChild(makeTodo(t, todos)));
        div.appendChild(ul); c.appendChild(div);
    });
}

function makeTodo(t, todosArr) {
    const li = document.createElement('li'); li.className = 'todo-item'; li.draggable = true;
    const pc = { '높음': 'priority-high', '낮음': 'priority-low' }[t.priority] ?? 'priority-mid';
    const curPrio = t.priority || '보통';
    li.innerHTML = `
    <div class="drag-handle todo-drag">⠿</div>
    <div class="todo-text"><div class="todo-task" contenteditable="true">${t.task}</div></div>
    <div class="todo-chips">
      <div class="td-dropdown prio-dd ${pc}" tabindex="0">
        <span class="td-chip prio-chip"><span class="td-chip-val">${curPrio}</span></span>
        <div class="td-menu prio-menu">
          ${['높음','보통','낮음'].map(v => `<div class="td-opt ${v === curPrio ? 'active' : ''} priority-${{ '높음':'high','보통':'mid','낮음':'low' }[v]}" data-val="${v}">${v}</div>`).join('')}
        </div>
      </div>
      <button class="row-del-btn todo-del-btn" title="삭제">✕</button>
    </div>`;
    li.querySelector('.todo-task').addEventListener('blur', e => { t.task = e.target.innerText.trim(); });

    const prioDd = li.querySelector('.prio-dd');
    prioDd.querySelectorAll('.td-opt').forEach(opt => {
        opt.addEventListener('click', e => {
            e.stopPropagation();
            const v = opt.dataset.val; t.priority = v;
            prioDd.querySelector('.td-chip-val').textContent = v;
            prioDd.querySelectorAll('.td-opt').forEach(o => o.classList.remove('active'));
            opt.classList.add('active');
            prioDd.classList.remove('priority-high', 'priority-mid', 'priority-low');
            prioDd.classList.add({ '높음': 'priority-high', '낮음': 'priority-low' }[v] ?? 'priority-mid');
            prioDd.classList.remove('open');
        });
    });
    prioDd.addEventListener('click', e => { const was = prioDd.classList.contains('open'); $$('.td-dropdown.open').forEach(d => d.classList.remove('open')); if (!was) prioDd.classList.add('open'); });
    prioDd.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') prioDd.click(); });

    li.querySelector('.todo-del-btn').addEventListener('click', () => {
        if (!confirm('이 항목을 삭제할까요?')) return;
        const i = todosArr.indexOf(t); if (i > -1) todosArr.splice(i, 1);
        renderTodos(todosArr);
    });
    addDragEvents(li);
    return li;
}

$('addTodoBtn').addEventListener('click', () => {
    const c = $('todoContent');
    c.querySelector('.todo-add-form')?.remove();
    const speakers = [...new Set($$('.utterance-text').map(el => +el.dataset.speaker).filter(n => !isNaN(n)))].sort((a, b) => a - b);
    const form = document.createElement('div'); form.className = 'todo-add-form';
    form.innerHTML = `
    <input class="todo-add-input" placeholder="새 할 일 입력..." />
    <select class="todo-add-spk custom-sel"><option value="">미정</option>${speakers.map(spk => `<option value="${spk}">${spkName(spk)}</option>`).join('')}</select>
    <select class="todo-add-priority custom-sel"><option value="보통">보통</option><option value="높음">높음</option><option value="낮음">낮음</option></select>
    <button class="todo-add-confirm" type="button">추가</button>
    <button class="todo-add-cancel"  type="button">취소</button>`;
    c.prepend(form); form.querySelector('.todo-add-input').focus();
    form.querySelector('.todo-add-confirm').addEventListener('click', () => {
        const task = form.querySelector('.todo-add-input').value.trim(); if (!task) return;
        const spkVal = form.querySelector('.todo-add-spk').value;
        const spk = spkVal === '' ? null : +spkVal;
        state.result.todos.unshift({ task, owner: spk !== null ? spkName(spk) : null, speaker: spk !== null ? spk - 1 : null, priority: form.querySelector('.todo-add-priority').value });
        form.remove(); renderTodos(state.result.todos);
    });
    form.querySelector('.todo-add-cancel').addEventListener('click', () => form.remove());
});

// ── 단어 수정 ────────────────────────────────────
function openWordReplaceModal() {
    $('wordFrom').value = ''; $('wordTo').value = ''; $('wordCaseSensitive').checked = false;
    $('wordReplacePreview').innerHTML = ''; $('wordConfirmBtn').disabled = true;
    $('wordReplaceBackdrop').classList.add('visible'); $('wordFrom').focus();
}
function closeWordReplaceModal() { $('wordReplaceBackdrop').classList.remove('visible'); }

$('wordReplaceBtn').addEventListener('click', openWordReplaceModal);
$('wordReplaceClose').addEventListener('click', closeWordReplaceModal);
$('wordReplaceBackdrop').addEventListener('click', e => e.target === $('wordReplaceBackdrop') && closeWordReplaceModal());

$('wordPreviewBtn').addEventListener('click', () => {
    const from = $('wordFrom').value.trim(), to = $('wordTo').value;
    const preview = $('wordReplacePreview');
    if (!from) { preview.innerHTML = '<span class="wr-warn">찾을 단어를 입력하세요.</span>'; $('wordConfirmBtn').disabled = true; return; }
    const re = safeRe(from, $('wordCaseSensitive').checked ? 'g' : 'gi');
    const count = $$('.utterance-text').reduce((acc, el) => acc + (el.innerText.match(re)?.length ?? 0), 0);
    if (!count) {
        preview.innerHTML = '<span class="wr-warn">일치하는 단어가 없습니다.</span>'; $('wordConfirmBtn').disabled = true;
    } else {
        preview.innerHTML = `<span class="wr-count"><b>${count}</b>건 발견 → "<b>${escHtml(to || '(빈 값)')}</b>"으로 변경됩니다.</span>`;
        $('wordConfirmBtn').disabled = false;
    }
});

[$('wordFrom'), $('wordTo'), $('wordCaseSensitive')].forEach(el =>
    el.addEventListener('input', () => { $('wordReplacePreview').innerHTML = ''; $('wordConfirmBtn').disabled = true; })
);
$('wordFrom').addEventListener('keydown', e => e.key === 'Enter' && $('wordPreviewBtn').click());
$('wordTo').addEventListener('keydown',   e => e.key === 'Enter' && $('wordPreviewBtn').click());

$('wordConfirmBtn').addEventListener('click', () => {
    const from = $('wordFrom').value.trim(), to = $('wordTo').value; if (!from) return;
    const re = safeRe(from, $('wordCaseSensitive').checked ? 'g' : 'gi');
    $$('.utterance-text').forEach(el => {
        const newText = el.innerText.replace(re, to); el.innerText = newText;
        const idx = +el.closest('.utterance-item')?.dataset.utteranceIdx;
        if (!isNaN(idx) && state.utterances[idx]) state.utterances[idx].text = newText;
    });
    $('wordReplacePreview').innerHTML = '<span class="wr-success">✅ 수정이 완료되었습니다.</span>';
    $('wordConfirmBtn').disabled = true;
    setTimeout(closeWordReplaceModal, 900);
});

const safeRe  = (p, f) => { try { return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), f); } catch { return new RegExp('(?!)', f); } };
const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── 재생성 / 다운로드 ────────────────────────────
$('regenBtn').addEventListener('click', async () => {
    const btn = $('regenBtn'), fab = $('fabSave');
    btn.disabled = fab.disabled = true; btn.textContent = '⏳ 재생성 중...'; fab.textContent = '⏳';
    hideErr();
    try {
        const form = new FormData();
        form.append('full_text', getFullText()); form.append('speaker_count', $('speakerCount').value);
        const res = await fetch(`${BACKEND}/regenerate`, { method: 'POST', body: form });
        if (!res.ok) throw new Error('재생성 실패');
        const data = await res.json();
        Object.assign(state.result, data);
        renderMinutes(data.minutes); renderTodos(data.todos);
        btn.textContent = '✅ 완료!'; fab.textContent = '✅';
        setTimeout(() => { btn.textContent = '🔄 재생성'; fab.textContent = '↻'; btn.disabled = fab.disabled = false; }, 2000);
        switchTab('minutes');
    } catch (e) {
        showErr('재생성 오류: ' + e.message);
        btn.textContent = '🔄 재생성'; fab.textContent = '↻'; btn.disabled = fab.disabled = false;
    }
});

const todosToMd = t => t.map(x => `- [ ] ${x.task}${x.owner ? ` (담당: ${x.owner})` : ''} [${x.priority || '보통'}]`).join('\n');

async function dlDocx(payload, filename) {
    const form = new FormData();
    form.append('minutes', payload.minutes ?? '');
    form.append('todos_json', JSON.stringify(payload.todos ?? []));
    form.append('transcript', payload.transcript ?? '');
    try {
        const res = await fetch(`${BACKEND}/generate-docx`, { method: 'POST', body: form });
        if (!res.ok) throw new Error();
        dlBlob(await res.blob(), filename);
    } catch { showErr('Word 다운로드 실패'); }
}

$('dlMinutesMd').addEventListener('click', () => state.result && dlBlob(new Blob([state.result.minutes], { type: 'text/markdown' }), '회의록.md'));
$('dlTodosMd').addEventListener('click',   () => state.result && dlBlob(new Blob([`# TO DO\n\n${todosToMd(state.result.todos)}`], { type: 'text/markdown' }), 'todo.md'));

// ── 분석 제출 ────────────────────────────────────
$('submitBtn').addEventListener('click', async () => {
    if (!state.file) return;
    hideErr(); setStep(2);
    $('submitBtn').style.display = 'none'; $('previewBtn').style.display = 'none';
    $('progressSection').classList.add('visible');

    const form = new FormData();
    form.append('file', state.file);
    form.append('speaker_count', $('speakerCount').value);
    form.append('language', $('language').value);

    setProgStep(1);
    let res;
    try { res = await fetch(`${BACKEND}/analyze`, { method: 'POST', body: form }); }
    catch (err) { return _submitErr('네트워크 오류: ' + err.message); }

    setProgStep(2);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    try {
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            buf += dec.decode(value, { stream: true });
            let boundary;
            while ((boundary = buf.indexOf('\n\n')) !== -1) {
                const part = buf.slice(0, boundary); buf = buf.slice(boundary + 2);
                const evM = part.match(/^event:\s*(\S+)/m), datM = part.match(/^data:\s*([\s\S]+)/m);
                if (!evM || !datM) continue;
                let data; try { data = JSON.parse(datM[1].trim()); } catch { continue; }

                if (evM[1] === 'progress') {
                    setProgStep(data.step);
                } else if (evM[1] === 'done') {
                    setProgStep(5);
                    const rRes = await fetch(`${BACKEND}/result/${data.job_id}`);
                    if (!rRes.ok) throw new Error('결과 조회 실패');
                    state.result = await rRes.json(); state.speakerNames = {};
                    renderTranscript(state.result.utterances);
                    buildSpeakerPanel(state.result.utterances);
                    renderMinutes(state.result.minutes);
                    renderTodos(state.result.todos);
                    await new Promise(r => setTimeout(r, 400));
                    Object.keys(_stepTimers).forEach(k => _stopElapsed(+k));
                    $('progressSection').classList.remove('visible');
                    $('resultsSection').classList.add('visible');
                    $('audioPlayerResult').classList.add('visible');
                    setStep(3); switchTab('transcript'); setupPlayer(); updateFab(); showNewAnalysisBar();
                    return;
                } else if (evM[1] === 'error') {
                    throw new Error(data.detail || '서버 오류');
                }
            }
        }
    } catch (err) { _submitErr('오류: ' + err.message); }
});

function _submitErr(msg) {
    Object.keys(_stepTimers).forEach(k => _stopElapsed(+k));
    $('progressSection').classList.remove('visible');
    // 패널이 열려 있으면 원위치 복귀
    if (newAnalysisBar.classList.contains('open')) { newAnalysisBar.before(uploadSection); newAnalysisBar.classList.remove('open'); newAnalysisPanel.style.maxHeight = '0'; }
    if (newAnalysisBar.classList.contains('visible')) { uploadSection.style.display = ''; } else { uploadSection.style.display = ''; }
    setStep(1); showErr(msg);
}

// ── 커스텀 컨트롤 초기화 ─────────────────────────
(function initConfigControls() {
    const inp = $('speakerCount'), val = $('stepperVal');
    $('stepperDown').addEventListener('click', () => { inp.value = Math.max(2, +inp.value - 1); val.textContent = inp.value; });
    $('stepperUp').addEventListener('click',   () => { inp.value = Math.min(10, +inp.value + 1); val.textContent = inp.value; });

    const wrap = $('langSelect'), hidden = $('language'), selected = $('langSelected');
    const toggle = open => wrap.classList.toggle('open', open);
    wrap.addEventListener('click', e => { e.stopPropagation(); toggle(!wrap.classList.contains('open')); });
    wrap.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') toggle(!wrap.classList.contains('open')); });
    $$('#langOptions .cs-option').forEach(opt => {
        opt.addEventListener('click', e => {
            e.stopPropagation(); hidden.value = opt.dataset.value; selected.textContent = opt.textContent;
            $$('#langOptions .cs-option').forEach(o => o.classList.remove('active'));
            opt.classList.add('active'); toggle(false);
        });
    });
    document.addEventListener('click', e => { if (!wrap.contains(e.target)) toggle(false); });
})();

// ── 결과 예시 보기 ────────────────────────────────
const DEMO_DATA = {
    utterances: [
        { speaker:0, text:"안녕하세요, 오늘 회의 시작할게요. 이번 분기 API 명세서 작성 일정 논의하려고 모였습니다.", start:0.5,  end:6.2  },
        { speaker:1, text:"네, 저는 인증 관련 엔드포인트 먼저 작성하면 좋겠다고 생각해요. 로그인, 회원가입, 토큰 갱신 이 세 가지요.", start:7.0,  end:14.5 },
        { speaker:2, text:"동의합니다. 그런데 에러 코드 체계도 먼저 정해야 할 것 같아요. 팀마다 다르게 쓰고 있어서 혼란스럽거든요.", start:15.2, end:22.8 },
        { speaker:0, text:"좋은 지적이에요. 에러 코드는 HTTP 표준을 기반으로 하되, 우리만의 세부 코드를 추가하는 방향으로 합시다.", start:23.5, end:31.0 },
        { speaker:1, text:"그럼 제가 에러 코드 초안 작성해서 내일까지 공유할게요. Confluence에 올리겠습니다.", start:31.8, end:38.4 },
        { speaker:2, text:"저는 결제 API 명세 담당할게요. 다음 주 화요일까지 초안 완성 목표로 하겠습니다.", start:39.1, end:46.0 },
        { speaker:0, text:"좋아요. 그리고 전체 API 문서 형식은 OpenAPI 3.0 스펙으로 통일하기로 결정합시다.", start:46.8, end:53.2 },
        { speaker:1, text:"Swagger UI도 연동하면 좋을 것 같은데요. 개발팀에서 요청이 많았거든요.", start:54.0, end:60.1 },
        { speaker:2, text:"저도 찬성이에요. 주소는 /api-docs로 통일하면 어떨까요?", start:60.8, end:66.5 },
        { speaker:0, text:"네, 그렇게 하죠. 마지막으로 리뷰 프로세스 얘기해볼게요. PR 올리면 최소 2명 이상 승인 받는 걸로 하면 어떨까요?", start:67.2, end:76.0 },
        { speaker:1, text:"좋습니다. 그리고 문서 변경 시 반드시 CHANGELOG도 업데이트하는 규칙 추가하면 좋겠어요.", start:76.8, end:84.3 },
        { speaker:0, text:"동의해요. 오늘 논의한 내용 정리해서 슬랙에 공유할게요. 수고하셨습니다.", start:85.0, end:91.5 },
    ],
    minutes: `# 회의 요약\nAPI 명세서 작성 일정 및 담당 업무를 분배하고, 문서 형식과 리뷰 프로세스를 확정했습니다.\n\n## 주요 논의사항\n- 인증 관련 엔드포인트 우선 작성\n- 에러 코드 HTTP 표준 기반 통일\n- OpenAPI 3.0 / Swagger UI(/api-docs) 도입\n- PR 리뷰 최소 2인 승인\n\n## 결정된 사항\n- API 문서: OpenAPI 3.0\n- Swagger UI 주소: /api-docs\n- 에러 코드: HTTP 표준 + 자체 세부 코드\n- PR 2인 승인 / CHANGELOG 업데이트 의무화`,
    todos: [
        { task:"에러 코드 초안 작성 후 Confluence 공유", owner:"발화자 2", speaker:1, priority:"높음" },
        { task:"결제 API 명세 초안 작성", owner:"발화자 3", speaker:2, priority:"높음" },
        { task:"Swagger UI 연동 설정", owner:null, speaker:null, priority:"보통" },
        { task:"오늘 회의 내용 슬랙 공유", owner:"발화자 1", speaker:0, priority:"낮음" },
    ],
};

let previewOpen = false;
$('previewBtn').addEventListener('click', () => {
    previewOpen = !previewOpen;
    const btn = $('previewBtn');
    if (!previewOpen) {
        $('resultsSection').classList.remove('visible');
        $('audioPlayerResult').classList.remove('visible');
        $('fabGroup').classList.remove('visible');
        hideNewAnalysisBar();
        btn.textContent = '👀 결과 예시 보기'; state.result = null; return;
    }
    btn.textContent = '✕ 예시 닫기';
    state.result = { utterances: DEMO_DATA.utterances, full_text: '', minutes: DEMO_DATA.minutes, todos: JSON.parse(JSON.stringify(DEMO_DATA.todos)), topics: [] };
    state.speakerNames = {};
    renderTranscript(state.result.utterances);
    buildSpeakerPanel(state.result.utterances);
    renderMinutes(state.result.minutes);
    renderTodos(state.result.todos);
    $('progressSection').classList.remove('visible');
    $('resultsSection').classList.add('visible');
    $('audioPlayerResult').classList.add('visible');
    setStep(3); switchTab('transcript'); updateFab(); showNewAnalysisBar();
    $('resultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ── 새 회의록 분석 바 ────────────────────────────
const newAnalysisBar   = $('newAnalysisBar');
const newAnalysisPanel = $('newAnalysisPanel');
const uploadSection    = $('uploadSection');

function showNewAnalysisBar() {
    uploadSection.style.display = 'none';
    newAnalysisBar.classList.add('visible');
    // 패널이 열려 있으면 닫기
    newAnalysisBar.classList.remove('open');
    newAnalysisPanel.style.maxHeight = '0';
    $('newAnalysisToggle').querySelector('.na-arrow').textContent = '▾';
}

function hideNewAnalysisBar() {
    // 패널 안에 있으면 원래 위치로 복귀
    if (newAnalysisPanel.contains(uploadSection)) {
        newAnalysisBar.before(uploadSection);
    }
    uploadSection.style.display = '';
    newAnalysisBar.classList.remove('visible', 'open');
    newAnalysisPanel.style.maxHeight = '0';
}

$('newAnalysisToggle').addEventListener('click', () => {
    const opening = !newAnalysisBar.classList.contains('open');
    newAnalysisBar.classList.toggle('open', opening);
    $('newAnalysisToggle').querySelector('.na-arrow').textContent = opening ? '▴' : '▾';

    if (opening) {
        // 업로드 섹션을 패널 안으로 이동 후 높이 계산
        newAnalysisPanel.appendChild(uploadSection);
        uploadSection.style.display = '';
        // 분석 버튼 복원 (분석 완료 후 숨겨진 상태일 수 있음)
        $('submitBtn').style.display = '';
        $('previewBtn').style.display = 'none';
        // 파일·에러 초기화
        state.file = null; $('fileInput').value = '';
        $('filePreview').classList.remove('visible');
        $('submitBtn').disabled = true;
        hideErr();
        // DOM 반영 후 높이 계산
        requestAnimationFrame(() => {
            newAnalysisPanel.style.maxHeight = newAnalysisPanel.scrollHeight + 'px';
            // 애니메이션 끝나면 none으로 풀어 내부 드롭다운 등 동작 보장
            newAnalysisPanel.addEventListener('transitionend', () => {
                if (newAnalysisBar.classList.contains('open'))
                    newAnalysisPanel.style.maxHeight = 'none';
            }, { once: true });
        });
        // 화면 스크롤
        setTimeout(() => newAnalysisBar.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    } else {
        // max-height를 현재 높이로 고정 후 0으로 줄여 애니메이션
        newAnalysisPanel.style.maxHeight = newAnalysisPanel.scrollHeight + 'px';
        requestAnimationFrame(() => {
            newAnalysisPanel.style.maxHeight = '0';
        });
        // 애니메이션 후 원래 위치로 복귀 및 숨김
        newAnalysisPanel.addEventListener('transitionend', () => {
            if (!newAnalysisBar.classList.contains('open')) {
                newAnalysisBar.before(uploadSection);
                uploadSection.style.display = 'none';
            }
        }, { once: true });
    }
});
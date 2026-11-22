(function () {
  'use strict';

  const KEY = 'odak-v1';
  const TIPS = window.ODAK_TIPS || [];
  const PROMPTS = [
    'Bugün ne iyi gitti?',
    'Kafamı ne meşgul ediyor?',
    'Şu an tek bir şey yapsam?',
    'Enerjim nasıl?',
    'Ertelediğim küçük şey?',
    'Kendime bir cümle'
  ];

  const ui = {
    screen: 'home',
    mode: 'focus',
    journal: {id: null, date: '', prompt: '', text: ''},
    taskTitle: '',
    steps: {},
    showDone: false,
    tipPos: null,
    writeFocus: false,
    stepFocus: ''
  };

  let state = load();
  let memoryOnly = false;
  let audioCtx = null;
  let deferredPrompt = null;
  let toastTimer = 0;

  function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function isoFromDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function todayISO() { return isoFromDate(new Date()); }
  function uid(p) {
    return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function safeId(id, p) {
    const s = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    return s || uid(p);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
    }[c]));
  }
  function fmtClock(sec) {
    sec = Math.max(0, sec | 0);
    return pad(Math.floor(sec / 60)) + ':' + pad(sec % 60);
  }
  function fmtMin(m) {
    m = Math.max(0, Math.round(Number(m) || 0));
    if (m < 60) return m + ' dk';
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? h + ' sa ' + r + ' dk' : h + ' sa';
  }
  function hm(ts) {
    return new Date(ts).toLocaleTimeString('tr-TR', {hour: '2-digit', minute: '2-digit'});
  }
  function humanDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const opts = {day: 'numeric', month: 'long', weekday: 'long'};
    if (y !== new Date().getFullYear()) opts.year = 'numeric';
    const base = dt.toLocaleDateString('tr-TR', opts);
    return iso === todayISO() ? 'Bugün · ' + base : base;
  }
  function greet() {
    const h = new Date().getHours();
    const p = h < 5 ? 'İyi geceler' : h < 11 ? 'Günaydın' : h < 18 ? 'İyi günler' : 'İyi akşamlar';
    return p + ', Kadir';
  }
  function heart(on) {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="' +
      (on ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="1.8"><path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2 4 4 0 0 1 7 2c0 4.6-7 9-7 9z"/></svg>';
  }

  function cleanJournal(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const j of list) {
      if (!j || typeof j.text !== 'string') continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(j.date || '')) continue;
      const text = j.text.trim().slice(0, 4000);
      if (!text) continue;
      out.push({
        id: safeId(j.id, 'j'),
        date: j.date,
        prompt: String(j.prompt || '').slice(0, 160),
        text: text,
        ts: Number(j.ts) || Date.now()
      });
      if (out.length >= 5000) break;
    }
    return out;
  }

  function cleanTasks(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    let focused = false;
    for (const t of list) {
      if (!t || typeof t.title !== 'string') continue;
      const title = t.title.trim().slice(0, 140);
      if (!title) continue;
      const steps = [];
      if (Array.isArray(t.steps)) {
        for (const s of t.steps) {
          if (!s || typeof s.title !== 'string') continue;
          const st = s.title.trim().slice(0, 100);
          if (!st) continue;
          steps.push({id: safeId(s.id, 'p'), title: st, done: !!s.done});
          if (steps.length >= 30) break;
        }
      }
      const done = !!t.done;
      let focus = !!t.focus && !done;
      if (focus && focused) focus = false;
      if (focus) focused = true;
      out.push({
        id: safeId(t.id, 't'),
        title: title,
        done: done,
        focus: focus,
        createdAt: Number(t.createdAt) || Date.now(),
        steps: steps
      });
      if (out.length >= 2000) break;
    }
    return out;
  }

  function cleanSessions(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const s of list) {
      if (!s || s.mode !== 'focus') continue;
      const minutes = Math.round(Number(s.minutes));
      const endedAt = Number(s.endedAt);
      if (!(minutes > 0 && minutes <= 180) || !isFinite(endedAt)) continue;
      const id = safeId(s.id, 's');
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id: id,
        mode: 'focus',
        minutes: minutes,
        endedAt: endedAt,
        taskId: String(s.taskId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40),
        taskTitle: String(s.taskTitle || '').slice(0, 140)
      });
      if (out.length >= 5000) break;
    }
    return out;
  }

  function cleanTimer(t) {
    if (!t || typeof t !== 'object') return null;
    if (!['running', 'paused', 'done'].includes(t.phase)) return null;
    const mode = t.mode === 'break' ? 'break' : 'focus';
    const cap = mode === 'break' ? 30 : 60;
    let mins = Math.round((Number(t.totalSec) || 0) / 60);
    if (mins < 5 || mins > cap) mins = mode === 'break' ? 5 : 15;
    const totalSec = mins * 60;
    let endsAt = t.phase === 'running' ? Number(t.endsAt) : null;
    if (t.phase === 'running') {
      if (!endsAt || endsAt > Date.now() + totalSec * 1000 + 10000) return null;
      if (endsAt < Date.now() - 36 * 3600 * 1000) return null;
    }
    let remainSec = clamp(Math.round(Number(t.remainSec) || 0), 0, totalSec);
    if (t.phase === 'paused' && remainSec <= 0) return null;
    return {
      phase: t.phase,
      mode: mode,
      totalSec: totalSec,
      remainSec: remainSec,
      endsAt: t.phase === 'running' ? endsAt : null,
      taskId: String(t.taskId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40),
      taskTitle: String(t.taskTitle || '').slice(0, 140),
      startedAt: Number(t.startedAt) || Date.now(),
      recorded: !!t.recorded
    };
  }

  function cleanSettings(s) {
    s = s && typeof s === 'object' ? s : {};
    let focusMin = Math.round(Number(s.focusMin) / 5) * 5;
    let breakMin = Math.round(Number(s.breakMin) / 5) * 5;
    if (!isFinite(focusMin)) focusMin = 15;
    if (!isFinite(breakMin)) breakMin = 5;
    const theme = ['system', 'dark', 'light'].includes(s.theme) ? s.theme : 'system';
    return {
      theme: theme,
      sound: s.sound !== false,
      vibrate: s.vibrate !== false,
      focusMin: clamp(focusMin, 5, 60),
      breakMin: clamp(breakMin, 5, 30),
      hintDismissed: !!s.hintDismissed
    };
  }

  function cleanState(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const known = new Set(TIPS.map(t => t.id));
    const favs = [];
    if (Array.isArray(raw.favs)) {
      for (const id of raw.favs) {
        const s = String(id || '');
        if (known.has(s) && favs.indexOf(s) < 0) favs.push(s);
      }
    }
    return {
      journal: cleanJournal(raw.journal),
      tasks: cleanTasks(raw.tasks),
      sessions: cleanSessions(raw.sessions),
      favs: favs,
      settings: cleanSettings(raw.settings),
      timer: cleanTimer(raw.timer)
    };
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      return cleanState(raw || {});
    } catch (e) {
      memoryOnly = true;
      return cleanState({});
    }
  }

  function stored() {
    return {
      app: 'odak',
      v: 1,
      journal: state.journal,
      tasks: state.tasks,
      sessions: state.sessions,
      favs: state.favs,
      settings: state.settings,
      timer: state.timer
    };
  }

  function persist() {
    if (memoryOnly) return;
    try { localStorage.setItem(KEY, JSON.stringify(stored())); }
    catch (e) { toast('Kaydedilemedi.'); }
  }

  function focusTask() {
    return state.tasks.find(t => t.focus && !t.done) || null;
  }

  function tipForDate(d) {
    const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
    const n = TIPS.length || 1;
    const index = ((day % n) + n) % n;
    return {tip: TIPS[index], index: index};
  }

  function tipIndex() {
    if (ui.tipPos == null) return tipForDate(new Date()).index;
    return ui.tipPos;
  }

  function startOfWeekIso(now) {
    const x = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = (x.getDay() + 6) % 7;
    x.setDate(x.getDate() - day);
    return isoFromDate(x);
  }

  function stats() {
    const today = todayISO();
    const week = startOfWeekIso(new Date());
    const out = {todayMin: 0, todayN: 0, weekMin: 0, weekN: 0, allMin: 0, allN: 0};
    for (const s of state.sessions) {
      out.allMin += s.minutes;
      out.allN++;
      const day = isoFromDate(new Date(s.endedAt));
      if (day === today) { out.todayMin += s.minutes; out.todayN++; }
      if (day >= week && day <= today) { out.weekMin += s.minutes; out.weekN++; }
    }
    return out;
  }

  function remainingSec() {
    const t = state.timer;
    if (!t || t.phase === 'idle') {
      const mins = ui.mode === 'break' ? state.settings.breakMin : state.settings.focusMin;
      return mins * 60;
    }
    if (t.phase === 'running' && t.endsAt) return Math.max(0, Math.ceil((t.endsAt - Date.now()) / 1000));
    if (t.phase === 'paused') return t.remainSec;
    return 0;
  }

  function armedMinutes() {
    return ui.mode === 'break' ? state.settings.breakMin : state.settings.focusMin;
  }

  function arm(mode) {
    const task = mode === 'focus' ? focusTask() : null;
    const mins = mode === 'break' ? state.settings.breakMin : state.settings.focusMin;
    const total = mins * 60;
    state.timer = {
      phase: 'running',
      mode: mode,
      totalSec: total,
      remainSec: total,
      endsAt: Date.now() + total * 1000,
      taskId: task ? task.id : '',
      taskTitle: task ? task.title : '',
      startedAt: Date.now(),
      recorded: false
    };
    unlockAudio();
    persist();
  }

  function finishTimer(opts) {
    const t = state.timer;
    if (!t || t.phase !== 'running') return;
    t.phase = 'done';
    t.remainSec = 0;
    t.endsAt = null;
    if (t.mode === 'focus' && !t.recorded) {
      t.recorded = true;
      const sid = 's' + t.startedAt;
      if (!state.sessions.some(s => s.id === sid)) {
        state.sessions.push({
          id: sid,
          mode: 'focus',
          minutes: Math.round(t.totalSec / 60),
          endedAt: Date.now(),
          taskId: t.taskId || '',
          taskTitle: t.taskTitle || ''
        });
      }
    }
    persist();
    if (!opts || !opts.silent) {
      if (state.settings.sound) chime();
      if (state.settings.vibrate) buzz();
    }
    toast(t.mode === 'break' ? 'Mola bitti' : 'Süre doldu');
    render();
  }

  function catchUp() {
    const t = state.timer;
    if (!t || t.phase !== 'running' || !t.endsAt) return;
    if (Date.now() >= t.endsAt) finishTimer({silent: Date.now() - t.endsAt > 15000});
  }

  function unlockAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
  }

  function chime() {
    try {
      unlockAudio();
      if (!audioCtx) return;
      const now = audioCtx.currentTime;
      [523.25, 659.25, 783.99].forEach((freq, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        const t0 = now + i * 0.16;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
        o.connect(g);
        g.connect(audioCtx.destination);
        o.start(t0);
        o.stop(t0 + 0.48);
      });
    } catch (e) {}
  }

  function buzz() {
    try { if (navigator.vibrate) navigator.vibrate([120, 70, 120]); } catch (e) {}
  }

  function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
  }

  function applyTheme() {
    const choice = state.settings.theme;
    const dark = choice === 'dark' || (choice !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#12161c' : '#f4f0e8');
  }

  function show(screen) {
    ui.screen = screen;
    render();
    window.scrollTo(0, 0);
  }

  function standalone() {
    return matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function hasJournalToday() {
    const today = todayISO();
    return state.journal.some(j => j.date === today);
  }

  function viewHome() {
    const today = tipForDate(new Date());
    const tip = today.tip;
    const fav = tip && state.favs.indexOf(tip.id) >= 0;
    const task = focusTask();
    const t = state.timer;
    let kicker = 'Odak zamanı';
    let name = 'Görev seçmeden de başlayabilirsin.';
    let nameClass = 'quiet';
    let before = '';
    let after = '';
    let btn = 'Başla';
    if (t && t.phase === 'running') {
      kicker = t.mode === 'break' ? 'Mola sürüyor' : 'Odak sürüyor';
      name = t.taskTitle || (t.mode === 'break' ? 'Kısa mola' : 'Görev seçilmedi');
      nameClass = 'quiet';
      before = '<div class="mini-clock" data-clock>' + fmtClock(remainingSec()) + '</div>';
      btn = 'Süreye git';
    } else if (t && t.phase === 'paused') {
      kicker = 'Duraklatıldı';
      name = t.taskTitle || 'Görev seçilmedi';
      nameClass = 'quiet';
      before = '<div class="mini-clock">' + fmtClock(t.remainSec) + '</div>';
      btn = 'Devam et';
    } else if (t && t.phase === 'done') {
      kicker = t.mode === 'break' ? 'Mola bitti' : 'Süre doldu';
      name = t.taskTitle || (t.mode === 'break' ? 'Kısa mola' : '');
      nameClass = name ? 'focus-name' : 'quiet';
      btn = 'Gör';
    } else if (task) {
      kicker = 'Şu an buna odaklanıyorum';
      name = task.title;
      nameClass = 'focus-name';
      if (task.steps.length) {
        const n = task.steps.filter(s => s.done).length;
        after = '<p class="quiet">' + n + '/' + task.steps.length + ' adım</p>';
      }
    }
    const hint = (!state.settings.hintDismissed && !standalone())
      ? '<div class="note"><p>Ana ekrana ekle, uygulama gibi açılsın.</p><div class="row"><button type="button" class="chip" data-act="go" data-screen="settings">Nasıl yapılır</button><button type="button" class="chip" data-act="dismiss-hint">Kapat</button></div></div>'
      : '';
    const wrote = hasJournalToday();
    const tipCard = tip ? (
      '<article class="card" data-tip-id="' + esc(tip.id) + '">' +
        '<p class="kicker">Bugünün ipucu · ' + esc(tip.cat) + '</p>' +
        '<p class="tiptext">' + esc(tip.text) + '</p>' +
        '<div class="row">' +
          '<button type="button" class="chip' + (fav ? ' on' : '') + '" data-act="fav" data-id="' + esc(tip.id) + '" aria-pressed="' + (fav ? 'true' : 'false') + '">' + heart(fav) + (fav ? 'Favoride' : 'Favorile') + '</button>' +
          '<button type="button" class="chip" data-act="go" data-screen="tips">Tüm ipuçları</button>' +
        '</div></article>'
    ) : '';
    return hint +
      '<h1 class="greet">' + esc(greet()) + '</h1>' +
      '<p class="date-line">' + esc(new Date().toLocaleDateString('tr-TR', {weekday: 'long', day: 'numeric', month: 'long'})) + '</p>' +
      tipCard +
      '<article class="card"><p class="kicker">Günlük</p><p class="' + (wrote ? 'quiet' : 'focus-name') + '">' +
        (wrote ? 'Bugün bir notun var.' : 'Bir cümle yeter.') + '</p>' +
        '<button type="button" class="btn secondary" data-act="go" data-screen="journal" data-write="' + (wrote ? '0' : '1') + '">' +
        (wrote ? 'Günlüğe bak' : 'Bir cümle yaz') + '</button></article>' +
      '<article class="card"><p class="kicker">' + esc(kicker) + '</p>' + before +
        (name ? '<p class="' + nameClass + '">' + esc(name) + '</p>' : '') + after +
        '<button type="button" class="btn primary" data-act="home-start">' + esc(btn) + '</button></article>';
  }

  function viewJournal() {
    if (!ui.journal.date) ui.journal.date = todayISO();
    const prompts = PROMPTS.map(p =>
      '<button type="button" data-act="prompt" data-prompt="' + esc(p) + '" aria-pressed="' + (ui.journal.prompt === p ? 'true' : 'false') + '" class="' + (ui.journal.prompt === p ? 'on' : '') + '">' + esc(p) + '</button>'
    ).join('');
    const groups = [];
    const items = state.journal.slice().sort((a, b) => (b.date === a.date ? b.ts - a.ts : b.date < a.date ? -1 : 1));
    for (const j of items) {
      const last = groups[groups.length - 1];
      if (!last || last.date !== j.date) groups.push({date: j.date, items: [j]});
      else last.items.push(j);
    }
    const history = groups.length ? groups.map(g =>
      '<h2>' + esc(humanDate(g.date)) + '</h2>' + g.items.map(j =>
        '<article class="entry"><div class="entry-top"><span>' + esc(j.prompt || 'Not') + '</span><span>' + esc(hm(j.ts)) + '</span></div>' +
        '<p>' + esc(j.text) + '</p><div class="row">' +
        '<button type="button" class="textbtn" data-act="edit-journal" data-id="' + esc(j.id) + '">Düzenle</button>' +
        '<button type="button" class="textbtn danger" data-act="del-journal" data-id="' + esc(j.id) + '">Sil</button>' +
        '</div></article>'
      ).join('')
    ).join('') : '<p class="quiet">Henüz not yok.</p>';
    const editing = ui.journal.id
      ? '<p class="quiet">Notu düzenliyorsun.</p><button type="button" class="textbtn" data-act="cancel-edit">Vazgeç</button>'
      : '';
    return '<h1>Günlük</h1><form class="card" data-act="save-journal">' + editing +
      '<label class="kicker" for="jdate">Tarih</label>' +
      '<input id="jdate" type="date" value="' + esc(ui.journal.date) + '">' +
      '<p class="kicker">İstersen bir soru seç</p><div class="prompts">' + prompts + '</div>' +
      '<label class="kicker" for="jtext">Not</label>' +
      '<textarea id="jtext" maxlength="4000" rows="4" placeholder="Bir cümle yeter." autocapitalize="sentences" spellcheck="true"></textarea>' +
      '<button type="submit" class="btn primary">' + (ui.journal.id ? 'Güncelle' : 'Kaydet') + '</button></form>' +
      '<section id="history">' + history + '</section>';
  }

  function viewFocus() {
    const t = state.timer;
    const phase = t ? t.phase : 'idle';
    const mode = phase === 'idle' ? ui.mode : t.mode;
    const total = phase === 'idle' ? armedMinutes() * 60 : t.totalSec;
    const sec = remainingSec();
    const pct = phase === 'done' ? 100 : (total ? clamp(sec / total * 100, 0, 100) : 0);
    const doneWord = mode === 'break' ? 'Mola bitti' : 'Bitti';
    const clock = phase === 'done'
      ? '<div id="clock" class="clock word" role="timer">' + doneWord + '</div>'
      : '<div id="clock" class="clock" role="timer" data-clock>' + fmtClock(sec) + '</div>';
    const sub = phase === 'done'
      ? fmtMin(Math.round(t.totalSec / 60))
      : (mode === 'break' ? 'Mola' : 'Odak');
    let taskLine = 'Görev seçilmedi';
    if (mode === 'break') taskLine = 'Kısa mola';
    else if (t && (phase === 'running' || phase === 'paused' || phase === 'done') && t.taskTitle) taskLine = t.taskTitle;
    else if (focusTask()) taskLine = focusTask().title;

    let controls = '';
    if (phase === 'running') {
      controls = '<button type="button" class="btn primary" data-act="pause">Duraklat</button><button type="button" class="textbtn" data-act="cancel">Vazgeç</button>';
    } else if (phase === 'paused') {
      controls = '<button type="button" class="btn primary" data-act="resume">Devam</button><button type="button" class="textbtn" data-act="cancel">Sıfırla</button>';
    } else if (phase === 'done') {
      const next = t.mode === 'break' ? 'Odak başlat' : 'Mola başlat';
      controls = '<button type="button" class="btn primary" data-act="start-next">' + next + '</button><button type="button" class="btn secondary" data-act="ack">Tamam</button>';
    } else {
      const presets = [10, 15, 25].map(m =>
        '<button type="button" data-act="preset" data-mode="focus" data-min="' + m + '" aria-pressed="' + (ui.mode === 'focus' && state.settings.focusMin === m ? 'true' : 'false') + '" class="' + (ui.mode === 'focus' && state.settings.focusMin === m ? 'on' : '') + '" aria-label="' + m + ' dakika">' + m + '</button>'
      ).join('');
      controls =
        '<div class="presets">' + presets +
          '<button type="button" data-act="preset" data-mode="break" aria-pressed="' + (ui.mode === 'break' ? 'true' : 'false') + '" class="' + (ui.mode === 'break' ? 'on' : '') + '">Mola</button></div>' +
        '<div class="adjust"><button type="button" data-act="bump" data-dir="-1" aria-label="Süreyi azalt">−</button><span>' +
          (ui.mode === 'break' ? state.settings.breakMin + ' dk mola' : state.settings.focusMin + ' dk odak') +
          '</span><button type="button" data-act="bump" data-dir="1" aria-label="Süreyi artır">+</button></div>' +
        '<button type="button" class="btn primary" data-act="start">' + (ui.mode === 'break' ? 'Molayı başlat' : 'Başla') + '</button>';
    }

    const st = stats();
    const stat = (mins, n, label) =>
      '<div><b>' + fmtMin(mins) + '</b><span>' + label + (n ? ' · ' + n + ' oturum' : '') + '</span></div>';
    const recent = state.sessions.slice(-5).reverse().map(s => {
      const when = isoFromDate(new Date(s.endedAt)) === todayISO()
        ? hm(s.endedAt)
        : new Date(s.endedAt).toLocaleDateString('tr-TR', {day: 'numeric', month: 'short'});
      return '<li><b>' + s.minutes + ' dk</b><span>' + esc(s.taskTitle || 'Görevsiz') + '</span><time>' + esc(when) + '</time></li>';
    }).join('');

    const open = state.tasks.filter(x => !x.done).sort((a, b) => (b.focus - a.focus) || (b.createdAt - a.createdAt));
    const done = state.tasks.filter(x => x.done).sort((a, b) => b.createdAt - a.createdAt);
    const tasks = open.map(task => taskArticle(task, true)).join('');
    const doneBlock = done.length
      ? '<button type="button" class="textbtn" data-act="toggle-done" aria-expanded="' + (ui.showDone ? 'true' : 'false') + '">Tamamlananlar · ' + done.length + '</button>' +
        (ui.showDone ? done.map(task => taskArticle(task, false)).join('') : '')
      : '';

    return '<h1>Zamanlayıcı</h1><section class="card">' +
      '<div class="ring' + (mode === 'break' ? ' break' : '') + '" id="ring" style="--p:' + pct.toFixed(2) + '"><div class="hole"><div class="clock-sub">' + esc(sub) + '</div>' + clock + '</div></div>' +
      '<p class="current-task">' + esc(taskLine) + '</p>' + controls + '</section>' +
      '<section class="card"><div class="stats">' + stat(st.todayMin, st.todayN, 'Bugün') + stat(st.weekMin, st.weekN, 'Bu hafta') + stat(st.allMin, st.allN, 'Toplam') + '</div></section>' +
      '<section id="tasks"><h2>Görevler</h2><form class="add-row" data-act="add-task" style="margin-bottom:12px"><input id="newTask" type="text" maxlength="140" placeholder="Küçük bir görev" aria-label="Yeni görev" autocomplete="off" autocapitalize="sentences" enterkeyhint="done"><button type="submit">Ekle</button></form>' +
      tasks + doneBlock +
      (recent ? '<h2>Son oturumlar</h2><ul class="log">' + recent + '</ul>' : '') + '</section>';
  }

  function taskArticle(task, open) {
    const steps = open ? task.steps.map(s =>
      '<label class="step"><input type="checkbox" data-act="toggle-step" data-id="' + esc(task.id) + '" data-step="' + esc(s.id) + '"' + (s.done ? ' checked' : '') + '><span class="txt' + (s.done ? ' done' : '') + '">' + esc(s.title) + '</span></label>'
    ).join('') : '';
    const allDone = task.steps.length > 0 && task.steps.every(s => s.done);
    return '<article class="task' + (task.focus ? ' is-focus' : '') + '"><div class="task-top"><label class="check">' +
      '<input type="checkbox" data-act="toggle-task" data-id="' + esc(task.id) + '"' + (task.done ? ' checked' : '') + '>' +
      '<span class="txt' + (task.done ? ' done' : '') + '">' + esc(task.title) + '</span></label>' +
      (open ? '<button type="button" class="chip' + (task.focus ? ' on' : '') + '" data-act="focus-task" data-id="' + esc(task.id) + '" aria-pressed="' + (task.focus ? 'true' : 'false') + '">' + (task.focus ? 'Seçili' : 'Buna odaklan') + '</button>' : '') +
      '</div>' +
      (open && task.focus ? '<p class="now">Şu an buna odaklanıyorum</p>' : '') +
      (open ? '<div class="steps">' + steps +
        (allDone ? '<button type="button" class="chip on" data-act="done-task" data-id="' + esc(task.id) + '">Görevi kapat</button>' : '') +
        '<form class="step-add" data-act="add-step" data-id="' + esc(task.id) + '"><input type="text" data-step-input="' + esc(task.id) + '" maxlength="100" placeholder="Küçük adım" aria-label="Küçük adım" autocomplete="off" autocapitalize="sentences"><button type="submit">Ekle</button></form></div>' : '') +
      '<button type="button" class="textbtn danger" data-act="del-task" data-id="' + esc(task.id) + '">Sil</button></article>';
  }

  function viewTips() {
    if (!TIPS.length) return '<h1>İpuçları</h1><p class="quiet">İpuçları yüklenemedi.</p>';
    const index = tipIndex();
    const tip = TIPS[index];
    const today = tipForDate(new Date()).index;
    const fav = state.favs.indexOf(tip.id) >= 0;
    const favButtons = state.favs.map(id => {
      const i = TIPS.findIndex(t => t.id === id);
      if (i < 0) return '';
      const item = TIPS[i];
      return '<button type="button" data-act="open-tip" data-index="' + i + '"><span class="kicker">' + esc(item.cat) + '</span><span class="favtext">' + esc(item.text) + '</span></button>';
    }).join('');
    return '<h1>İpuçları</h1><article class="card" data-tip-id="' + esc(tip.id) + '">' +
      '<p class="kicker">' + esc(tip.cat) + ' · ' + (index + 1) + ' / ' + TIPS.length + (index === today ? ' · bugün' : '') + '</p>' +
      '<p class="tiptext">' + esc(tip.text) + '</p>' +
      '<div class="row"><button type="button" class="btn secondary" data-act="tip-move" data-dir="-1">Önceki</button>' +
      '<button type="button" class="btn secondary" data-act="tip-move" data-dir="1">Sonraki</button></div>' +
      '<button type="button" class="chip' + (fav ? ' on' : '') + '" data-act="fav" data-id="' + esc(tip.id) + '" aria-pressed="' + (fav ? 'true' : 'false') + '" style="width:100%;margin-top:8px">' +
      heart(fav) + (fav ? 'Favoride' : 'Favorile') + '</button>' +
      (index !== today ? '<button type="button" class="btn secondary" data-act="tip-today">Bugüne dön</button>' : '') +
      '</article>' +
      (favButtons ? '<section class="card"><h2>Favoriler</h2><div class="favlist">' + favButtons + '</div></section>' : '<p class="quiet">Beğendiğini Favorile ile sakla.</p>') +
      '<p class="quiet">Tıbbi tavsiye değildir.</p>';
  }

  function viewSettings() {
    const theme = state.settings.theme;
    const seg = (id, label) =>
      '<button type="button" data-act="theme" data-theme="' + id + '" class="' + (theme === id ? 'on' : '') + '" aria-pressed="' + (theme === id ? 'true' : 'false') + '">' + label + '</button>';
    return '<h1>Ayarlar</h1>' +
      '<section class="card"><h2>Görünüm</h2><div class="seg" role="group" aria-label="Görünüm">' +
        seg('system', 'Sistem') + seg('dark', 'Koyu') + seg('light', 'Açık') + '</div></section>' +
      '<section class="card"><h2>Zamanlayıcı</h2>' +
        '<label class="switchline"><span>Süre bitince ses</span><input type="checkbox" data-act="set-sound"' + (state.settings.sound ? ' checked' : '') + '></label>' +
        '<label class="switchline"><span>Süre bitince titreşim</span><input type="checkbox" data-act="set-vibrate"' + (state.settings.vibrate ? ' checked' : '') + '></label></section>' +
      '<section class="card"><h2>Yedek</h2>' +
        '<button type="button" class="btn secondary" id="exportBtn" data-act="export">Yedeği indir</button>' +
        '<button type="button" class="btn secondary" id="importBtn" data-act="import">Yedek yükle</button>' +
        '<input id="importFile" type="file" accept="application/json,.json" hidden>' +
        '<p class="quiet">Kayıtlar yalnız bu telefonda durur. Silmeden önce yedeği indir.</p></section>' +
      '<section class="card about" id="about"><h2>Hakkında</h2>' +
        '<p>Odak, günlük bir destek aracıdır. Tedavi değildir.</p>' +
        '<p>İpuçları genel stratejilerdir. Tıbbi tavsiye, tanı veya tedavi yerine geçmez. İlaç ve terapi için psikiyatristinle devam et.</p>' +
        '<p>Ana ekrana eklemek için Chrome menüsü → Ana ekrana ekle → Ekle.</p>' +
        '<button type="button" class="btn primary" id="installBtn" data-act="install" hidden>Uygulamayı yükle</button></section>';
  }

  function render() {
    const app = document.getElementById('app');
    if (!app) return;
    const focusId = document.activeElement && document.activeElement.id;
    const focusStep = document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.stepInput
      : '';
    const views = {home: viewHome, journal: viewJournal, focus: viewFocus, tips: viewTips, settings: viewSettings};
    app.dataset.screen = ui.screen;
    app.innerHTML = (views[ui.screen] || viewHome)();
    const setBtn = document.getElementById('setBtn');
    if (setBtn) setBtn.setAttribute('aria-current', ui.screen === 'settings' ? 'page' : 'false');
    document.querySelectorAll('#nav button').forEach(b => {
      const on = b.dataset.screen === ui.screen;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    const jt = document.getElementById('jtext');
    if (jt) jt.value = ui.journal.text;
    const nt = document.getElementById('newTask');
    if (nt) nt.value = ui.taskTitle;
    document.querySelectorAll('[data-step-input]').forEach(inp => {
      inp.value = ui.steps[inp.dataset.stepInput] || '';
    });
    const inst = document.getElementById('installBtn');
    if (inst) inst.hidden = !deferredPrompt;
    if (ui.stepFocus) {
      const stepEl = document.querySelector('[data-step-input="' + CSS.escape(ui.stepFocus) + '"]');
      ui.stepFocus = '';
      if (stepEl) stepEl.focus();
    } else if (ui.writeFocus && jt) {
      ui.writeFocus = false;
      jt.focus();
    } else if (focusId === 'jtext' || focusId === 'newTask') {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus();
        try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {}
      }
    } else if (focusStep) {
      const el = document.querySelector('[data-step-input="' + CSS.escape(focusStep) + '"]');
      if (el) {
        el.focus();
        try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {}
      }
    }
  }

  function saveJournal() {
    const text = ui.journal.text.trim();
    if (!text) { toast('Bir cümle yaz.'); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(ui.journal.date) ? ui.journal.date : todayISO();
    if (ui.journal.id) {
      const j = state.journal.find(x => x.id === ui.journal.id);
      if (j) {
        j.text = text.slice(0, 4000);
        j.date = date;
        j.prompt = ui.journal.prompt;
      }
    } else {
      state.journal.push({
        id: uid('j'),
        date: date,
        prompt: ui.journal.prompt,
        text: text.slice(0, 4000),
        ts: Date.now()
      });
    }
    ui.journal = {id: null, date: date, prompt: '', text: ''};
    persist();
    render();
    toast('Kaydedildi');
    const entry = document.querySelector('#history .entry');
    if (entry) entry.scrollIntoView({block: 'nearest'});
  }

  async function importFile(file) {
    if (!file) return;
    let raw;
    try { raw = JSON.parse(await file.text()); }
    catch (e) { toast('Dosya okunamadı.'); return; }
    if (!raw || raw.app !== 'odak') { toast('Bu dosya Odak yedeği değil.'); return; }
    if (raw.v && raw.v !== 1) { toast('Bu yedek bu sürümle açılmıyor.'); return; }
    if (!confirm('Yedek yüklenecek ve bu telefondaki Odak kayıtlarının yerini alacak. Devam edilsin mi?')) return;
    const next = cleanState(raw);
    state = next;
    state.timer = null;
    ui.journal = {id: null, date: todayISO(), prompt: '', text: ''};
    ui.taskTitle = '';
    ui.steps = {};
    ui.mode = 'focus';
    ui.tipPos = null;
    persist();
    applyTheme();
    show('home');
    toast('Yedek yüklendi');
  }

  const actions = {
    go(el) {
      if (el.dataset.write === '1') ui.writeFocus = true;
      show(el.dataset.screen || 'home');
    },
    preset(el) {
      ui.mode = el.dataset.mode === 'break' ? 'break' : 'focus';
      if (ui.mode === 'focus' && el.dataset.min) state.settings.focusMin = clamp(Number(el.dataset.min), 5, 60);
      persist();
      render();
    },
    bump(el) {
      const dir = Number(el.dataset.dir) || 0;
      if (ui.mode === 'break') state.settings.breakMin = clamp(state.settings.breakMin + dir * 5, 5, 30);
      else state.settings.focusMin = clamp(state.settings.focusMin + dir * 5, 5, 60);
      persist();
      render();
    },
    start() {
      if (state.timer && state.timer.phase === 'running') return;
      arm(ui.mode);
      render();
    },
    pause() {
      const t = state.timer;
      if (!t || t.phase !== 'running') return;
      t.remainSec = Math.max(1, Math.ceil((t.endsAt - Date.now()) / 1000));
      t.endsAt = null;
      t.phase = 'paused';
      persist();
      render();
    },
    resume() {
      const t = state.timer;
      if (!t || t.phase !== 'paused') return;
      unlockAudio();
      t.endsAt = Date.now() + t.remainSec * 1000;
      t.phase = 'running';
      persist();
      render();
    },
    cancel() {
      state.timer = null;
      persist();
      render();
    },
    ack() {
      state.timer = null;
      persist();
      render();
    },
    'start-next'() {
      const mode = state.timer && state.timer.mode === 'focus' ? 'break' : 'focus';
      ui.mode = mode;
      arm(mode);
      render();
    },
    'home-start'() {
      const t = state.timer;
      if (t && t.phase === 'running') { show('focus'); return; }
      if (t && t.phase === 'paused') { actions.resume(); show('focus'); return; }
      if (t && t.phase === 'done') { show('focus'); return; }
      ui.mode = 'focus';
      arm('focus');
      show('focus');
    },
    'add-task'(form) {
      const input = form.querySelector('input');
      const title = (input && input.value || ui.taskTitle || '').trim();
      if (!title) { toast('Bir görev yaz.'); return; }
      state.tasks.push({
        id: uid('t'),
        title: title.slice(0, 140),
        done: false,
        focus: false,
        createdAt: Date.now(),
        steps: []
      });
      ui.taskTitle = '';
      persist();
      render();
    },
    'del-task'(el) {
      if (!confirm('Bu görev silinsin mi?')) return;
      state.tasks = state.tasks.filter(t => t.id !== el.dataset.id);
      persist();
      render();
    },
    'focus-task'(el) {
      const t = state.tasks.find(x => x.id === el.dataset.id);
      if (!t || t.done) return;
      const next = !t.focus;
      state.tasks.forEach(x => { x.focus = false; });
      t.focus = next;
      if (state.timer && (state.timer.phase === 'running' || state.timer.phase === 'paused') && state.timer.mode === 'focus') {
        state.timer.taskId = next ? t.id : '';
        state.timer.taskTitle = next ? t.title : '';
      }
      persist();
      render();
    },
    'toggle-task'(el) {
      const t = state.tasks.find(x => x.id === el.dataset.id);
      if (!t) return;
      t.done = !!el.checked;
      if (t.done) t.focus = false;
      persist();
      render();
    },
    'toggle-step'(el) {
      const t = state.tasks.find(x => x.id === el.dataset.id);
      const s = t && t.steps.find(x => x.id === el.dataset.step);
      if (!s) return;
      s.done = !!el.checked;
      persist();
      render();
    },
    'add-step'(form) {
      const t = state.tasks.find(x => x.id === form.dataset.id);
      if (!t) return;
      const input = form.querySelector('input');
      const title = (input && input.value || ui.steps[t.id] || '').trim();
      if (!title) { toast('Küçük bir adım yaz.'); return; }
      t.steps.push({id: uid('p'), title: title.slice(0, 100), done: false});
      ui.steps[t.id] = '';
      ui.stepFocus = t.id;
      persist();
      render();
    },
    'done-task'(el) {
      const t = state.tasks.find(x => x.id === el.dataset.id);
      if (!t) return;
      t.done = true;
      t.focus = false;
      persist();
      render();
      toast('Görev kapandı');
    },
    'toggle-done'() {
      ui.showDone = !ui.showDone;
      render();
    },
    prompt(el) {
      const p = el.dataset.prompt || '';
      ui.journal.prompt = ui.journal.prompt === p ? '' : p;
      render();
    },
    'save-journal': saveJournal,
    'edit-journal'(el) {
      const j = state.journal.find(x => x.id === el.dataset.id);
      if (!j) return;
      ui.journal = {id: j.id, date: j.date, prompt: j.prompt || '', text: j.text};
      ui.writeFocus = true;
      render();
      window.scrollTo(0, 0);
    },
    'cancel-edit'() {
      ui.journal = {id: null, date: todayISO(), prompt: '', text: ''};
      render();
    },
    'del-journal'(el) {
      if (!confirm('Bu not silinsin mi?')) return;
      state.journal = state.journal.filter(j => j.id !== el.dataset.id);
      if (ui.journal.id === el.dataset.id) ui.journal = {id: null, date: todayISO(), prompt: '', text: ''};
      persist();
      render();
    },
    fav(el) {
      const id = el.dataset.id;
      const i = state.favs.indexOf(id);
      if (i >= 0) state.favs.splice(i, 1);
      else if (TIPS.some(t => t.id === id)) state.favs.push(id);
      persist();
      render();
    },
    'tip-move'(el) {
      const n = TIPS.length;
      if (!n) return;
      const dir = Number(el.dataset.dir) || 1;
      const next = (tipIndex() + dir + n) % n;
      const today = tipForDate(new Date()).index;
      ui.tipPos = next === today ? null : next;
      render();
    },
    'tip-today'() {
      ui.tipPos = null;
      render();
    },
    'open-tip'(el) {
      const i = Number(el.dataset.index);
      if (!TIPS[i]) return;
      const today = tipForDate(new Date()).index;
      ui.tipPos = i === today ? null : i;
      render();
      window.scrollTo(0, 0);
    },
    theme(el) {
      const theme = el.dataset.theme;
      if (!['system', 'dark', 'light'].includes(theme)) return;
      state.settings.theme = theme;
      persist();
      applyTheme();
      render();
    },
    'set-sound'(el) {
      state.settings.sound = !!el.checked;
      persist();
    },
    'set-vibrate'(el) {
      state.settings.vibrate = !!el.checked;
      persist();
    },
    export() {
      const payload = {
        app: 'odak',
        v: 1,
        exportedAt: new Date().toISOString(),
        journal: state.journal,
        tasks: state.tasks,
        sessions: state.sessions,
        favs: state.favs,
        settings: state.settings
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = 'odak-yedek-' + todayISO() + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('Yedek indi');
    },
    import() {
      const input = document.getElementById('importFile');
      if (input) input.click();
    },
    'dismiss-hint'() {
      state.settings.hintDismissed = true;
      persist();
      render();
    },
    async install() {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (e) {}
      deferredPrompt = null;
      const b = document.getElementById('installBtn');
      if (b) b.hidden = true;
    }
  };

  document.body.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.matches('input, textarea, select')) return;
    if (el.closest('form') && el.getAttribute('type') === 'submit') return;
    const fn = actions[el.dataset.act];
    if (fn) fn(el);
  });
  document.body.addEventListener('change', e => {
    const el = e.target;
    if (el.id === 'importFile') {
      importFile(el.files && el.files[0]);
      el.value = '';
      return;
    }
    if (!el.dataset || !el.dataset.act) return;
    const fn = actions[el.dataset.act];
    if (fn) fn(el);
  });
  document.body.addEventListener('submit', e => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    const fn = actions[form.dataset.act];
    if (!fn) return;
    e.preventDefault();
    fn(form);
  });
  document.body.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'jtext') ui.journal.text = t.value;
    if (t.id === 'jdate') ui.journal.date = t.value;
    if (t.id === 'newTask') ui.taskTitle = t.value;
    if (t.dataset && t.dataset.stepInput) ui.steps[t.dataset.stepInput] = t.value;
  });
  document.addEventListener('pointerdown', () => unlockAudio(), {passive: true});

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    const b = document.getElementById('installBtn');
    if (b) b.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    toast('Ana ekrana eklendi');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    catchUp();
    const t = state.timer;
    if (t && t.phase === 'running') {
      document.querySelectorAll('[data-clock]').forEach(el => { el.textContent = fmtClock(remainingSec()); });
    }
  });
  window.addEventListener('storage', e => {
    if (e.key !== KEY || !e.newValue) return;
    try {
      state = cleanState(JSON.parse(e.newValue));
      applyTheme();
      render();
    } catch (err) {}
  });
  setInterval(() => {
    const t = state.timer;
    if (!t || t.phase !== 'running' || !t.endsAt) return;
    if (Date.now() >= t.endsAt) finishTimer({silent: false});
    else {
      const sec = remainingSec();
      document.querySelectorAll('[data-clock]').forEach(el => { el.textContent = fmtClock(sec); });
      const ring = document.getElementById('ring');
      if (ring && t.totalSec) ring.style.setProperty('--p', String(sec / t.totalSec * 100));
    }
  }, 250);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  applyTheme();
  if (!ui.journal.date) ui.journal.date = todayISO();
  render();
  catchUp();
})();

'use strict';

(function () {
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var SIM = params.get('sim') === '1';

  var muted = localStorage.getItem('eds-mute') === '1';
  var model = null;
  var session = null;
  var map = null;
  var userLayer = null;
  var accLayer = null;
  var follow = true;
  var haveView = false;
  var lastPan = 0;
  var lastFix = null;
  var lastResult = null;
  var actx = null;
  var flashTimer = 0;
  var wakeSentinel = null;
  var wantWake = false;
  var geoWatch = null;
  var smoothHeading = null;
  var prevFix = null;
  var gotFix = false;
  var lastFixAt = 0;
  var lastAcc = null;
  var coarseTried = false;
  var coarseInFlight = false;
  var geoTimer = 0;
  var pendingPos = null;
  var lastConsumed = 0;

  var sim = {
    path: null,
    playing: false,
    along: 0,
    vtime: 0,
    rate: clampNum(params.get('rate'), 10, 1, 40),
    speed: clampNum(params.get('speed'), 120, 40, 150),
    bookmarks: { approach: 1200, inside: 9000 },
    lastFrame: 0,
    raf: 0
  };

  function clampNum(value, fallback, min, max) {
    var n = parseFloat(value);
    if (!isFinite(n)) n = fallback;
    return Math.max(min, Math.min(max, n));
  }

  function fmtDist(m) {
    if (m == null || !isFinite(m)) return '–';
    if (m < 1000) return Math.round(m) + ' m';
    var km = m / 1000;
    var digits = km < 10 ? 1 : 0;
    return km.toLocaleString('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + ' km';
  }

  function fmtKm(km) {
    if (km == null || !isFinite(km)) return '–';
    return km.toLocaleString('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' km';
  }

  function fmtDur(sec) {
    if (sec == null || !isFinite(sec)) return '–';
    var s = Math.max(0, Math.round(sec));
    var m = Math.floor(s / 60);
    var r = s % 60;
    if (m >= 60) {
      var h = Math.floor(m / 60);
      return h + ':' + String(m % 60).padStart(2, '0') + ':' + String(r).padStart(2, '0');
    }
    return m + ':' + String(r).padStart(2, '0');
  }

  function fmtClock(ms) {
    try {
      return new Date(ms).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (e) {
      return '–';
    }
  }

  function kindLabel(kind) {
    if (kind === 'radar') return 'Sabit radar';
    if (kind === 'egm') return 'EGM koridoru';
    return 'Ortalama hız koridoru';
  }

  function limitLabel(limit) {
    return limit ? ('Limit ' + Math.round(limit) + ' km/h') : 'Limit bilinmiyor';
  }

  function precisionLabel(precision) {
    return precision === 'kesin' ? 'Kesin' : 'Yaklaşık';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function paintMute() {
    var btn = $('muteBtn');
    btn.textContent = muted ? 'Ses kapalı' : 'Ses açık';
    btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    btn.classList.toggle('is-muted', muted);
  }

  function paintWake() {
    $('wake').hidden = !wakeSentinel;
  }

  function acquireWake() {
    wantWake = true;
    if (!('wakeLock' in navigator) || wakeSentinel) return;
    navigator.wakeLock.request('screen').then(function (sentinel) {
      wakeSentinel = sentinel;
      sentinel.addEventListener('release', function () {
        wakeSentinel = null;
        paintWake();
      });
      paintWake();
    }).catch(function () { paintWake(); });
  }

  function unlockAudio() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!actx) actx = new AC();
    if (actx.state === 'suspended') actx.resume();
  }

  function beep(count, freq) {
    try {
      unlockAudio();
      if (!actx) return;
      var t = actx.currentTime;
      for (var i = 0; i < count; i++) {
        var osc = actx.createOscillator();
        var gain = actx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        var start = t + i * 0.2;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
        osc.connect(gain);
        gain.connect(actx.destination);
        osc.start(start);
        osc.stop(start + 0.18);
      }
    } catch (e) { /* autoplay or missing API */ }
  }

  function fireAlert(alert) {
    var near = alert.level === '300m';
    var flash = $('flash');
    flash.hidden = false;
    flash.className = 'flash ' + (near ? 'near' : 'far');
    flash.textContent = (near ? '300 m kaldı' : '1 km kaldı') + ' · ' + alert.name;
    $('live').textContent = flash.textContent;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { flash.hidden = true; }, 3200);
    if (muted) return;
    beep(near ? 3 : 2, near ? 1240 : 880);
    try {
      if (typeof navigator.vibrate === 'function') {
        navigator.vibrate(near ? [280, 70, 280, 70, 280] : [180, 90, 180]);
      }
    } catch (e) { /* iOS Safari has no vibration */ }
  }

  function renderNext(result) {
    $('corCard').hidden = true;
    $('also').hidden = true;
    $('also').replaceChildren();
    document.body.classList.remove('in-corridor');
    $('nextCard').hidden = false;
    if (!result.next) {
      $('nextKicker').textContent = 'EDS';
      $('nextName').textContent = result.nextMode === 'sonraki' ? 'İleride EDS yok' : 'Yakında EDS yok';
      $('nextDist').textContent = '–';
      $('nextMeta').textContent = '';
      $('nextExtra').textContent = '';
      return;
    }
    $('nextKicker').textContent = result.nextMode === 'sonraki' ? 'Sonraki EDS' : 'En yakın EDS';
    $('nextName').textContent = result.next.name;
    $('nextDist').textContent = fmtDist(result.next.dist);
    $('nextMeta').textContent = [
      kindLabel(result.next.kind),
      limitLabel(result.next.limit),
      precisionLabel(result.next.precision)
    ].join(' · ');
    $('nextExtra').textContent = (result.nextCorridors || []).map(function (c) {
      return 'Koridor: ' + c.name + ' · ' + fmtDist(c.dist) + ' · ' + limitLabel(c.limit);
    }).join('\n');
  }

  function renderInside(result) {
    var list = result.insides;
    var primary = list[0];
    var card = $('corCard');
    card.hidden = false;
    $('nextCard').hidden = true;
    document.body.classList.add('in-corridor');
    var known = primary.avgKmh != null && primary.limit;
    card.classList.toggle('over', !!primary.over);
    card.classList.toggle('ok', !!(known && !primary.over));
    $('corName').textContent = primary.name;
    $('corLimit').textContent = primary.limit ? (Math.round(primary.limit) + ' km/h') : 'Limit yok';
    $('corRoad').textContent = primary.yol || primary.aciklama || kindLabel(primary.kind);
    $('corAvg').textContent = primary.avgKmh == null
      ? '–'
      : Math.round(primary.avgKmh).toLocaleString('tr-TR');
    $('corVerdict').textContent = !known ? '' : (primary.over ? 'Limit üstü' : 'Limit altında');
    $('corDriven').textContent = fmtKm(primary.drivenKm);
    $('corRemain').textContent = fmtKm(primary.remainingKm);
    $('corElapsed').textContent = fmtDur(primary.elapsedSec);
    $('corBar').style.width = Math.round(primary.progress * 100) + '%';
    if (primary.remainingMinSec == null) {
      $('corMin').textContent = '–';
      $('corExit').textContent = '';
    } else if (primary.remainingMinSec <= 0) {
      $('corMin').textContent = 'Çıkış serbest';
      $('corExit').textContent = 'Asgari süre doldu';
    } else {
      $('corMin').textContent = fmtDur(primary.remainingMinSec);
      $('corExit').textContent = 'En erken yasal çıkış ' + fmtClock(primary.earliestExitMs);
    }
    var notes = [];
    if (primary.publishedKm && primary.minTimeLabel) {
      notes.push('Tabela ' + fmtKm(primary.publishedKm) + ' · asgari ' + primary.minTimeLabel + '.');
    } else if (primary.publishedKm) {
      notes.push('Tabela ' + fmtKm(primary.publishedKm) + '.');
    }
    notes.push(precisionLabel(primary.precision) + '.');
    notes.push('Ortalama, tabeladaki mesafeye göredir.');
    if (primary.mid) notes.push('Giriş kapısı görülmedi; süre kalan mesafeye göre.');
    $('corNote').textContent = notes.join(' ');
    var ahead = $('ahead');
    if (result.next && result.nextMode === 'sonraki') {
      ahead.hidden = false;
      ahead.textContent = 'Öndeki: ' + result.next.name + ' · ' + fmtDist(result.next.dist) +
        (result.next.limit ? ' · limit ' + Math.round(result.next.limit) : '');
    } else {
      ahead.hidden = true;
    }
    var also = $('also');
    also.replaceChildren();
    list.slice(1).forEach(function (item) {
      var p = document.createElement('p');
      p.className = 'also' + (item.over ? ' over' : '');
      var avg = item.avgKmh == null ? '–' : Math.round(item.avgKmh).toLocaleString('tr-TR');
      p.textContent = item.name + ' · ort. ' + avg + ' km/h · kalan ' + fmtKm(item.remainingKm);
      also.appendChild(p);
    });
    also.hidden = list.length < 2;
  }

  function apply(result, fix) {
    lastResult = result;
    lastFix = { lat: result.lat, lng: result.lng, accuracy: fix && fix.accuracy };
    $('speedVal').textContent = result.speedKmh == null ? '–' : String(Math.round(result.speedKmh));
    if (result.insides.length) renderInside(result);
    else renderNext(result);
    result.alerts.forEach(fireAlert);
    if (mapOpen()) showUser(result.lat, result.lng, fix && fix.accuracy);
  }

  function mapOpen() {
    return !$('mapWrap').hidden;
  }

  function showUser(lat, lng, accuracy) {
    if (!map || !window.L) return;
    var ll = [lat, lng];
    var radius = Math.max(12, Math.min(accuracy || 20, 500));
    if (!userLayer) {
      accLayer = L.circle(ll, { radius: radius, color: '#7dd3fc', weight: 1, fillColor: '#38bdf8', fillOpacity: 0.12 });
      userLayer = L.circleMarker(ll, { radius: 8, color: '#e0f2fe', weight: 3, fillColor: '#38bdf8', fillOpacity: 1 });
      accLayer.addTo(map);
      userLayer.addTo(map);
    } else {
      userLayer.setLatLng(ll);
      accLayer.setLatLng(ll);
      accLayer.setRadius(radius);
    }
    if (follow) {
      var now = performance.now();
      if (!haveView) {
        map.setView(ll, 13);
        haveView = true;
      } else if (now - lastPan > 450) {
        map.panTo(ll);
        lastPan = now;
      }
    }
  }

  function popupHtml(lines) {
    return lines.filter(Boolean).map(esc).join('<br>');
  }

  function ensureMap() {
    if (map) {
      setTimeout(function () { map.invalidateSize(); }, 60);
      if (lastFix) showUser(lastFix.lat, lastFix.lng, lastFix.accuracy);
      return;
    }
    if (!window.L) {
      $('mapMsg').hidden = false;
      $('mapMsg').textContent = 'Harita yüklenemedi. Mesafe göstergesi çalışmaya devam eder.';
      return;
    }
    map = L.map('map', { zoomControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    if (map.attributionControl) map.attributionControl.addAttribution('Kaynak: YolRadar');
    var bounds = [];
    model.corridors.forEach(function (c) {
      var latlngs = c.latlngs.map(function (p) { return [p.lat, p.lng]; });
      var lineStyle = { color: '#ff4d4d', weight: 5, opacity: 0.95 };
      if (c.kind === 'corridor_egm') lineStyle.dashArray = '7 8';
      L.polyline(latlngs, lineStyle).bindPopup(popupHtml([
        c.name,
        c.limit ? ('Limit ' + c.limit + ' km/h') : 'Limit bilinmiyor',
        c.publishedKm ? ('Tabela ' + c.publishedKm + ' km') : '',
        c.minTimeLabel ? ('Asgari ' + c.minTimeLabel) : '',
        c.yol || c.aciklama,
        precisionLabel(c.precision),
        c.precisionTr
      ])).addTo(map);
      latlngs.forEach(function (ll) { bounds.push(ll); });
    });
    model.radars.forEach(function (r) {
      L.circleMarker([r.lat, r.lng], {
        radius: 7,
        color: '#ffd089',
        weight: 2,
        fillColor: '#ff8a00',
        fillOpacity: 0.95
      }).bindPopup(popupHtml([
        r.name,
        r.road,
        limitLabel(r.limit),
        'Sabit radar',
        precisionLabel(r.precision)
      ])).addTo(map);
      bounds.push([r.lat, r.lng]);
    });
    if (bounds.length) map.fitBounds(bounds, { padding: [18, 18] });
    map.on('dragstart', function () {
      follow = false;
      $('followBtn').hidden = false;
    });
    setTimeout(function () {
      map.invalidateSize();
      if (lastFix) showUser(lastFix.lat, lastFix.lng, lastFix.accuracy);
    }, 80);
  }

  function setMapOpen(open) {
    $('mapWrap').hidden = !open;
    $('mapBtn').textContent = open ? 'Haritayı gizle' : 'Haritayı göster';
    $('mapBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) ensureMap();
  }

  function paintFix() {
    var el = $('fixMeta');
    if (!el) return;
    if (!lastFixAt) {
      el.hidden = true;
      return;
    }
    var age = Math.max(0, Math.round((Date.now() - lastFixAt) / 1000));
    var acc = (lastAcc != null && isFinite(lastAcc)) ? ('±' + Math.round(lastAcc) + ' m') : 'doğruluk yok';
    var when = age < 2 ? 'şimdi' : (age + ' sn önce');
    var text = 'GPS · ' + acc + ' · son konum ' + when;
    if (age >= 20) text += ' · güncellenmiyor';
    if (lastAcc != null && lastAcc > 1000) text += ' · Tam Konum kapalı olabilir';
    el.hidden = false;
    el.textContent = text;
  }

  function geoCopy(err) {
    var code = err && err.code;
    if (err && err.insecure) {
      return {
        title: 'Konum alınamadı',
        hint: 'Konum yalnızca HTTPS sayfada çalışır. Adres https://kayabsg00.github.io/marti-paket/eds/ olmalı.'
      };
    }
    if (err && err.unsupported) {
      return {
        title: 'Konum alınamadı',
        hint: 'Bu tarayıcı konum vermiyor. iPhone’da Safari ile açın.'
      };
    }
    if (code === 1) {
      return {
        title: 'Konum izni reddedildi',
        hint: 'Ayarlar > Gizlilik > Konum Servisleri > Safari Web Siteleri bölümünü “Uygulamayı Kullanırken” yapın. Safari’de adres çubuğundaki aA menüsünden Web Sitesi Ayarları > Konum > İzin Ver. Sonra Tekrar dene.'
      };
    }
    if (code === 3) {
      return {
        title: 'Konum zaman aşımı',
        hint: 'GPS henüz kilitlenmedi. Açık alanda tekrar dokunun. Ayarlar > Gizlilik > Konum Servisleri > Safari Web Siteleri içinde Tam Konum açık olsun.'
      };
    }
    return {
      title: 'Konum alınamadı',
      hint: 'Ayarlar > Gizlilik > Konum Servisleri > Safari Web Siteleri izinli olsun. Açık alanda Başlat’a tekrar dokunun.'
    };
  }

  function showGeoError(err) {
    clearTimeout(geoTimer);
    var copy = geoCopy(err);
    var status = $('status');
    status.textContent = copy.title;
    status.classList.add('bad');
    var box = $('geoError');
    box.hidden = false;
    box.textContent = copy.title + '. ' + copy.hint;
    $('live').textContent = box.textContent;
    var btn = $('startBtn');
    btn.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Tekrar dene';
  }

  function armWatchdog(ms) {
    clearTimeout(geoTimer);
    geoTimer = setTimeout(function () {
      if (!gotFix) showGeoError({ code: 3 });
    }, ms);
  }

  function onFix(pos) {
    if (!pos || !pos.coords) return;
    gotFix = true;
    coarseInFlight = false;
    clearTimeout(geoTimer);
    pendingPos = pos;
    lastFixAt = Date.now();
    lastAcc = typeof pos.coords.accuracy === 'number' ? pos.coords.accuracy : null;
    $('geoError').hidden = true;
    $('status').classList.remove('bad');
    $('status').textContent = 'Konum açık';
    $('startBtn').hidden = true;
    $('startBtn').disabled = false;
    paintFix();
    if (!session) return;
    var stamp = pos.timestamp;
    if (typeof stamp !== 'number' || !isFinite(stamp) || stamp <= 0) stamp = lastFixAt;
    else if (stamp < 1e12) stamp = stamp * 1000;
    if (stamp === lastConsumed) return;
    lastConsumed = stamp;
    var c = pos.coords;
    var t = stamp;
    var lat = c.latitude;
    var lng = c.longitude;
    var speed = (typeof c.speed === 'number' && c.speed >= 0 && c.speed < 70) ? c.speed : null;
    var heading = (typeof c.heading === 'number' && isFinite(c.heading)) ? c.heading : null;
    if (prevFix) {
      var dist = EDS.haversine(prevFix, { lat: lat, lng: lng });
      var dt = (t - prevFix.t) / 1000;
      if (speed == null && dt > 0.3 && dt < 30) speed = dist / dt;
      if (dist > 8) {
        var b = EDS.bearing(prevFix, { lat: lat, lng: lng });
        smoothHeading = smoothHeading == null ? b : EDS.lerpAngle(smoothHeading, b, 0.45);
      }
    }
    if (heading == null) heading = smoothHeading;
    else smoothHeading = heading;
    prevFix = { lat: lat, lng: lng, t: t };
    var result = session.push({
      lat: lat,
      lng: lng,
      speedMps: speed,
      heading: heading,
      timeMs: Date.now(),
      accuracy: c.accuracy
    });
    apply(result, { accuracy: c.accuracy });
    acquireWake();
  }

  function fail(err) {
    if (gotFix) {
      if (err && err.code === 1) showGeoError(err);
      else paintFix();
      return;
    }
    if (coarseInFlight) return;
    if (err && err.code !== 1 && !coarseTried && navigator.geolocation) {
      coarseTried = true;
      coarseInFlight = true;
      $('status').classList.remove('bad');
      $('status').textContent = 'Hassas konum gecikti, yaklaşık konum deneniyor…';
      try {
        navigator.geolocation.getCurrentPosition(onFix, function (e2) {
          coarseInFlight = false;
          if (!gotFix) showGeoError(e2 || err);
        }, { enableHighAccuracy: false, maximumAge: 120000, timeout: 20000 });
      } catch (e) {
        coarseInFlight = false;
        showGeoError(err);
      }
      armWatchdog(25000);
      return;
    }
    showGeoError(err);
  }

  function startGps() {
    if (!window.isSecureContext) {
      showGeoError({ insecure: true });
      return;
    }
    if (!navigator.geolocation) {
      showGeoError({ unsupported: true });
      return;
    }
    coarseTried = false;
    coarseInFlight = false;
    $('status').classList.remove('bad');
    $('status').textContent = 'Konum alınıyor…';
    $('geoError').hidden = true;
    $('geoError').textContent = '';
    $('startBtn').disabled = true;
    $('startBtn').textContent = 'Konum alınıyor…';
    armWatchdog(70000);
    var fine = { enableHighAccuracy: true, maximumAge: 15000, timeout: 60000 };
    var watchOpts = { enableHighAccuracy: true, maximumAge: 2000, timeout: 120000 };
    try {
      navigator.geolocation.getCurrentPosition(onFix, fail, fine);
      if (geoWatch != null) navigator.geolocation.clearWatch(geoWatch);
      geoWatch = navigator.geolocation.watchPosition(onFix, function (err) {
        if (err && err.code === 1) fail(err);
        else if (gotFix) paintFix();
      }, watchOpts);
    } catch (e) {
      showGeoError({ code: 2 });
    }
  }

  function paintSim() {
    $('simToggle').textContent = sim.playing ? 'Duraklat' : 'Sürdür';
    $('simSpeedVal').textContent = String(Math.round(sim.speed));
    $('simSpeed').value = String(Math.round(sim.speed));
    $('simBanner').textContent = 'Sınama modu — Korkuteli güzergahı · ' + sim.rate + '× · gerçek GPS değil';
    document.querySelectorAll('#simDock [data-rate]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(Number(btn.getAttribute('data-rate')) === sim.rate));
    });
    var done = !sim.playing && sim.along >= sim.path.lengthM - 1;
    $('status').textContent = done ? 'Sınama bitti · Baştan ile tekrarla' : 'Sınama · ±8 m';
  }

  function pushSim(timeMs, alerts) {
    var p = EDS.pointAlong(sim.path.points, sim.along);
    var h = EDS.headingAlong(sim.path.points, sim.along);
    return session.push({
      lat: p.lat,
      lng: p.lng,
      heading: h,
      timeMs: timeMs,
      speedMps: sim.speed / 3.6,
      accuracy: 8
    }, { alerts: alerts !== false });
  }

  function seek(meters, paused) {
    session = EDS.createSession(model);
    sim.along = 0;
    var t0 = Date.now();
    var v = sim.speed / 3.6;
    var step = 30;
    var last = null;
    if (meters <= 0) {
      sim.vtime = t0;
      last = pushSim(t0, false);
    } else {
      var m = 0;
      while (m < meters - 0.1) {
        m = Math.min(meters, m + step);
        sim.along = m;
        sim.vtime = t0 + (m / v) * 1000;
        last = pushSim(sim.vtime, false);
      }
    }
    sim.playing = !paused;
    sim.lastFrame = performance.now();
    paintSim();
    if (last) apply(last, { accuracy: 8 });
    runSim();
  }

  function findBookmarks() {
    var scan = EDS.createSession(model);
    var v = sim.speed / 3.6;
    var t0 = Date.now();
    var approach = 0;
    var inside = null;
    for (var m = 0; m <= sim.path.lengthM; m += 40) {
      var p = EDS.pointAlong(sim.path.points, m);
      var h = EDS.headingAlong(sim.path.points, m);
      var r = scan.push({
        lat: p.lat, lng: p.lng, heading: h,
        timeMs: t0 + (m / v) * 1000,
        speedMps: v
      }, { alerts: false });
      if (!approach && r.next && r.nextMode === 'sonraki' && r.next.dist <= 1600 && r.next.dist >= 1200) approach = m;
      var kor = r.insides.filter(function (i) { return i.id === 'korkuteli'; })[0];
      if (inside == null && kor && r.insides.length === 1 && kor.drivenKm > 3) inside = m;
    }
    sim.bookmarks.approach = approach || 0;
    sim.bookmarks.inside = inside == null ? Math.min(sim.path.lengthM * 0.55, sim.path.lengthM) : inside;
  }

  function simFrame(now) {
    sim.raf = 0;
    if (!sim.playing) return;
    var dt = Math.min(0.25, (now - sim.lastFrame) / 1000);
    sim.lastFrame = now;
    var simDt = dt * sim.rate;
    sim.vtime += simDt * 1000;
    sim.along += (sim.speed / 3.6) * simDt;
    if (sim.along >= sim.path.lengthM) {
      sim.along = sim.path.lengthM;
      sim.playing = false;
      paintSim();
    }
    var result = pushSim(sim.vtime, true);
    apply(result, { accuracy: 8 });
    if (sim.playing) sim.raf = requestAnimationFrame(simFrame);
  }

  function runSim() {
    if (!sim.playing || sim.raf) return;
    sim.lastFrame = performance.now();
    sim.raf = requestAnimationFrame(simFrame);
  }

  function startSim(fc) {
    sim.path = EDS.buildSimPath(fc);
    if (!sim.path) {
      $('status').textContent = 'Sınama güzergahı yok';
      return;
    }
    $('simBanner').hidden = false;
    $('simDock').hidden = false;
    findBookmarks();
    var at = params.get('at');
    var paused = params.get('pause') === '1';
    if (at === 'inside') seek(sim.bookmarks.inside, true);
    else if (at === 'approach') seek(sim.bookmarks.approach, paused);
    else if (at && isFinite(parseFloat(at))) seek(parseFloat(at), paused);
    else seek(0, paused);
    if (params.get('map') === '1') setMapOpen(true);
    runSim();
  }

  $('muteBtn').addEventListener('click', function () {
    muted = !muted;
    localStorage.setItem('eds-mute', muted ? '1' : '0');
    paintMute();
    unlockAudio();
    acquireWake();
  });
  $('startBtn').addEventListener('click', function () {
    startGps();
    try { unlockAudio(); } catch (e) {}
    try { acquireWake(); } catch (e) {}
  });
  $('mapBtn').addEventListener('click', function () {
    unlockAudio();
    acquireWake();
    setMapOpen($('mapWrap').hidden);
  });
  $('followBtn').addEventListener('click', function () {
    follow = true;
    $('followBtn').hidden = true;
    if (lastFix && map) {
      map.panTo([lastFix.lat, lastFix.lng]);
      haveView = true;
    }
  });
  document.addEventListener('pointerdown', function () {
    unlockAudio();
    if (wantWake || SIM || geoWatch != null) acquireWake();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && wantWake) acquireWake();
  });

  $('simToggle').addEventListener('click', function () {
    if (sim.along >= sim.path.lengthM - 1) {
      seek(0, false);
      return;
    }
    sim.playing = !sim.playing;
    sim.lastFrame = performance.now();
    paintSim();
    runSim();
  });
  $('simReset').addEventListener('click', function () { seek(0, false); });
  $('simApproach').addEventListener('click', function () { seek(sim.bookmarks.approach, false); });
  $('simInside').addEventListener('click', function () { seek(sim.bookmarks.inside, false); });
  $('simSpeed').addEventListener('input', function () {
    sim.speed = clampNum(this.value, sim.speed, 40, 150);
    $('simSpeedVal').textContent = String(Math.round(sim.speed));
  });
  document.querySelectorAll('#simDock [data-rate]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      sim.rate = Number(btn.getAttribute('data-rate'));
      paintSim();
    });
  });

  paintMute();

  if ('serviceWorker' in navigator) {
    var hadController = !!navigator.serviceWorker.controller;
    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('./sw.js').catch(function () {});
  }

  setInterval(paintFix, 1000);

  if (SIM) $('startBtn').hidden = true;

  fetch('eds.geojson').then(function (res) {
    if (!res.ok) throw new Error('veri');
    return res.json();
  }).then(function (fc) {
    model = EDS.buildModel(fc);
    session = EDS.createSession(model);
    if (SIM) startSim(fc);
    else if (pendingPos) onFix(pendingPos);
    else if (!$('geoError').hidden) { /* keep the iOS error on screen */ }
    else if ($('startBtn').disabled) $('status').textContent = 'Konum alınıyor…';
    else if (!gotFix) $('status').textContent = 'Konum için Başlat’a dokun.';
  }).catch(function () {
    $('status').textContent = 'EDS verisi yüklenemedi. Bağlantıyı kontrol edip yenile.';
    $('status').classList.add('bad');
  });
})();

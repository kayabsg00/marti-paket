'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EDS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var EARTH = 6371000;
  var ENTER_M = 150;
  var STAY_M = 230;
  var OUT_SAMPLES = 3;
  var AHEAD_DEG = 70;
  var BEND_DEG = 110;
  var BEND_M = 2500;
  var SNAP_M = 450;

  function haversine(a, b) {
    var p1 = a.lat * Math.PI / 180;
    var p2 = b.lat * Math.PI / 180;
    var dp = (b.lat - a.lat) * Math.PI / 180;
    var dl = (b.lng - a.lng) * Math.PI / 180;
    var s = Math.sin(dp / 2) * Math.sin(dp / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function bearing(a, b) {
    var p1 = a.lat * Math.PI / 180;
    var p2 = b.lat * Math.PI / 180;
    var dl = (b.lng - a.lng) * Math.PI / 180;
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function angleDiff(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  function lerpAngle(a, b, t) {
    var d = ((b - a + 540) % 360) - 180;
    return (a + d * t + 360) % 360;
  }

  function parseDuration(text) {
    if (!text || typeof text !== 'string') return null;
    var dk = /(\d+)\s*dk/.exec(text);
    var sn = /(\d+)\s*sn/.exec(text);
    if (!dk && !sn) return null;
    return (dk ? parseInt(dk[1], 10) * 60 : 0) + (sn ? parseInt(sn[1], 10) : 0);
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function projectSegment(p, a, b) {
    var lat0 = ((a.lat + b.lat) / 2) * Math.PI / 180;
    var x = function (lng) { return lng * Math.PI / 180 * Math.cos(lat0) * EARTH; };
    var y = function (lat) { return lat * Math.PI / 180 * EARTH; };
    var ax = x(a.lng);
    var ay = y(a.lat);
    var bx = x(b.lng);
    var by = y(b.lat);
    var px = x(p.lng);
    var py = y(p.lat);
    var dx = bx - ax;
    var dy = by - ay;
    var len2 = dx * dx + dy * dy;
    if (len2 < 0.01) return null;
    var tRaw = ((px - ax) * dx + (py - ay) * dy) / len2;
    var t = Math.max(0, Math.min(1, tRaw));
    var dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    var segLen = Math.sqrt(len2);
    return { t: t, tRaw: tRaw, dist: dist, segLen: segLen, along: t * segLen };
  }

  function projectPolyline(p, c) {
    var best = null;
    var last = c.latlngs.length - 2;
    for (var i = 0; i <= last; i++) {
      var seg = projectSegment(p, c.latlngs[i], c.latlngs[i + 1]);
      if (!seg) continue;
      if (!best || seg.dist < best.dist) {
        best = {
          dist: seg.dist,
          along: c.cum[i] + seg.along,
          t: seg.t,
          tRaw: seg.tRaw,
          segIndex: i
        };
      }
    }
    if (!best) {
      return { dist: Infinity, along: 0, t: 0, tRaw: 0, segIndex: 0, between: false };
    }
    var atStart = best.segIndex === 0 && best.tRaw <= 0;
    var atEnd = best.segIndex === last && best.tRaw >= 1;
    best.between = !atStart && !atEnd;
    return best;
  }

  function buildModel(fc) {
    var corridors = [];
    var radars = [];
    var features = (fc && fc.features) || [];
    features.forEach(function (f) {
      var p = f.properties || {};
      var g = f.geometry || {};
      if ((p.kind === 'corridor' || p.kind === 'corridor_egm') && g.type === 'LineString') {
        var latlngs = g.coordinates.map(function (c) { return { lat: c[1], lng: c[0] }; });
        var cum = [0];
        for (var i = 0; i < latlngs.length - 1; i++) {
          cum.push(cum[i] + haversine(latlngs[i], latlngs[i + 1]));
        }
        var lengthM = cum[cum.length - 1];
        var publishedKm = num(p.published_km);
        var limit = num(p.limit);
        var minSeconds = parseDuration(p.min_time);
        if (minSeconds == null && publishedKm && limit) minSeconds = publishedKm / limit * 3600;
        corridors.push({
          id: p.id || p.name,
          name: p.name || 'Koridor',
          kind: p.kind,
          limit: limit,
          publishedKm: publishedKm,
          minSeconds: minSeconds,
          minTimeLabel: p.min_time || null,
          precision: p.precision || '',
          precisionTr: p.precision_tr || '',
          yol: p.yol || '',
          ilce: p.ilce || '',
          aciklama: p.aciklama || '',
          latlngs: latlngs,
          cum: cum,
          lengthM: lengthM
        });
      } else if (p.kind === 'fixed_radar' && g.type === 'Point') {
        radars.push({
          id: 'radar-' + radars.length,
          name: p.name || 'Radar',
          limit: num(p.limit),
          road: p.road || '',
          precision: p.precision || 'yaklasik',
          lat: g.coordinates[1],
          lng: g.coordinates[0]
        });
      }
    });
    return { corridors: corridors, radars: radars };
  }

  function beginRun(c, proj, sample, prevAlong) {
    var len = c.lengthM;
    var segBrg = bearing(c.latlngs[proj.segIndex], c.latlngs[proj.segIndex + 1]);
    var dir = 1;
    if (prevAlong != null && Math.abs(proj.along - prevAlong) > 2) {
      dir = proj.along >= prevAlong ? 1 : -1;
    } else if (sample.heading != null && isFinite(sample.heading)) {
      dir = angleDiff(sample.heading, segBrg) > 90 ? -1 : 1;
    }
    var entryAlong = proj.along;
    var entryTime = sample.timeMs;
    var mid = true;
    var speed = sample.speedMps;
    var fromGate = dir === 1 ? proj.along : (len - proj.along);
    if (fromGate <= SNAP_M) {
      entryAlong = dir === 1 ? 0 : len;
      mid = false;
      if (speed && speed > 2) {
        entryTime -= Math.min(25000, (fromGate / speed) * 1000);
      }
    }
    return {
      active: true,
      outCount: 0,
      entryAlong: entryAlong,
      entryTime: entryTime,
      dir: dir,
      mid: mid
    };
  }

  function measure(c, st, proj, sample) {
    var len = c.lengthM;
    var drivenM = st.dir === 1
      ? Math.max(0, proj.along - st.entryAlong)
      : Math.max(0, st.entryAlong - proj.along);
    var remainingM = st.dir === 1
      ? Math.max(0, len - proj.along)
      : Math.max(0, proj.along);
    var tripM = st.dir === 1 ? Math.max(0, len - st.entryAlong) : st.entryAlong;
    var publishedM = c.publishedKm ? c.publishedKm * 1000 : len;
    var scale = len > 1 ? publishedM / len : 1;
    var drivenKm = drivenM * scale / 1000;
    var remainingKm = remainingM * scale / 1000;
    var tripKm = tripM * scale / 1000;
    var elapsedSec = Math.max(0, (sample.timeMs - st.entryTime) / 1000);
    var avgKmh = null;
    if (elapsedSec >= 2 && drivenKm >= 0.02) avgKmh = drivenKm / (elapsedSec / 3600);
    var minTripSec = null;
    if (c.minSeconds != null && c.publishedKm) {
      minTripSec = c.minSeconds * (c.publishedKm > 0 ? tripKm / c.publishedKm : 1);
    } else if (c.limit && tripKm > 0) {
      minTripSec = tripKm / c.limit * 3600;
    }
    var remainingMinSec = minTripSec == null ? null : minTripSec - elapsedSec;
    var over = !!(c.limit && avgKmh != null && avgKmh > c.limit + 0.5);
    return {
      id: c.id,
      name: c.name,
      kind: c.kind === 'corridor_egm' ? 'egm' : 'corridor',
      limit: c.limit,
      precision: c.precision,
      precisionTr: c.precisionTr,
      yol: c.yol,
      aciklama: c.aciklama,
      minTimeLabel: c.minTimeLabel,
      publishedKm: c.publishedKm,
      drivenKm: drivenKm,
      remainingKm: remainingKm,
      tripKm: tripKm,
      elapsedSec: elapsedSec,
      avgKmh: avgKmh,
      earliestExitMs: minTripSec == null ? null : st.entryTime + minTripSec * 1000,
      remainingMinSec: remainingMinSec,
      over: over,
      mid: st.mid,
      progress: tripM > 1 ? Math.max(0, Math.min(1, drivenM / tripM)) : 0
    };
  }

  function nearest(list) {
    var best = null;
    for (var i = 0; i < list.length; i++) {
      if (!best || list[i].dist < best.dist) best = list[i];
    }
    return best;
  }

  function createSession(model) {
    var states = new Map();
    var lastAlong = new Map();
    var alertDist = new Map();
    var seenFar = new Set();
    var seenNear = new Set();

    function reset() {
      states.clear();
      lastAlong.clear();
      alertDist.clear();
      seenFar.clear();
      seenNear.clear();
    }

    function push(sample, opts) {
      var emitAlerts = !opts || opts.alerts !== false;
      var lat = sample.lat;
      var lng = sample.lng;
      var heading = sample.heading != null && isFinite(sample.heading) ? sample.heading : null;
      var speedKmh = null;
      if (sample.speedMps != null && isFinite(sample.speedMps) && sample.speedMps >= 0 && sample.speedMps < 70) {
        speedKmh = sample.speedMps * 3.6;
      }
      var pos = { lat: lat, lng: lng };
      var insideIds = new Set();
      var insides = [];

      model.corridors.forEach(function (c) {
        var proj = projectPolyline(pos, c);
        var prev = lastAlong.has(c.id) ? lastAlong.get(c.id) : null;
        var st = states.get(c.id);
        var threshold = st && st.active ? STAY_M : ENTER_M;
        var insideNow = proj.between && proj.dist <= threshold;
        if (insideNow) {
          if (!st || !st.active) st = beginRun(c, proj, sample, prev);
          st.active = true;
          st.outCount = 0;
          states.set(c.id, st);
        } else if (st && st.active) {
          st.outCount += 1;
          if (st.outCount >= OUT_SAMPLES) st.active = false;
          states.set(c.id, st);
        }
        lastAlong.set(c.id, proj.along);
        if (st && st.active) {
          insideIds.add(c.id);
          insides.push(measure(c, st, proj, sample));
        }
      });

      insides.sort(function (a, b) { return a.remainingKm - b.remainingKm; });

      var pool = [];
      model.corridors.forEach(function (c) {
        if (insideIds.has(c.id)) return;
        var ends = [c.latlngs[0], c.latlngs[c.latlngs.length - 1]];
        ends.forEach(function (e, idx) {
          pool.push({
            id: c.id + ':' + (idx === 0 ? 'a' : 'b'),
            name: c.name,
            kind: c.kind === 'corridor_egm' ? 'egm' : 'corridor',
            limit: c.limit,
            precision: c.precision,
            lat: e.lat,
            lng: e.lng,
            corridorId: c.id
          });
        });
      });
      model.radars.forEach(function (r) {
        pool.push({
          id: r.id,
          name: r.name,
          kind: 'radar',
          limit: r.limit,
          precision: r.precision,
          road: r.road,
          lat: r.lat,
          lng: r.lng
        });
      });

      var moving = !!(heading != null && speedKmh != null && speedKmh >= 8);
      var annotated = [];
      pool.forEach(function (t) {
        var dist = haversine(pos, t);
        var brg = bearing(pos, t);
        var diff = heading == null ? null : angleDiff(heading, brg);
        if (dist < 40 && diff != null && diff > 100) return;
        annotated.push({
          id: t.id,
          name: t.name,
          kind: t.kind,
          limit: t.limit,
          precision: t.precision,
          road: t.road || '',
          corridorId: t.corridorId || null,
          dist: dist,
          bearing: brg,
          diff: diff
        });
      });

      var ahead = [];
      var bend = [];
      if (moving) {
        annotated.forEach(function (t) {
          if (t.diff <= AHEAD_DEG) ahead.push(t);
          if (t.diff <= BEND_DEG && t.dist <= BEND_M) bend.push(t);
        });
      }
      var bestAhead = nearest(ahead);
      var bestBend = nearest(bend);
      var next = null;
      var nextMode = null;
      if (moving && (bestAhead || bestBend)) {
        nextMode = 'sonraki';
        if (bestAhead && bestBend) next = (bestBend.dist + 80 < bestAhead.dist) ? bestBend : bestAhead;
        else next = bestAhead || bestBend;
      } else if (annotated.length) {
        next = nearest(annotated);
        nextMode = 'enyakin';
      }

      var corridorCandidates = annotated.filter(function (t) {
        return (t.kind === 'corridor' || t.kind === 'egm') && t.dist <= 25000;
      });
      var corridorPool = corridorCandidates;
      if (moving) {
        var cAhead = corridorCandidates.filter(function (t) { return t.diff <= AHEAD_DEG; });
        var cBend = corridorCandidates.filter(function (t) { return t.diff <= BEND_DEG && t.dist <= 5000; });
        corridorPool = cAhead.length ? cAhead : cBend;
      }
      corridorPool = corridorPool.slice().sort(function (a, b) { return a.dist - b.dist; });
      var seenCorridors = new Set();
      var nextCorridors = [];
      corridorPool.forEach(function (t) {
        if (next && t.id === next.id) return;
        var key = t.corridorId || t.id;
        if (seenCorridors.has(key)) return;
        seenCorridors.add(key);
        if (nextCorridors.length < 2) nextCorridors.push(t);
      });

      var alerts = [];
      var canAlert = next && (nextMode === 'sonraki' || !moving);
      if (next) {
        var prevD = alertDist.has(next.id) ? alertDist.get(next.id) : null;
        if (canAlert && next.dist <= 1000 && (prevD == null || prevD > 1000) && !seenFar.has(next.id)) {
          seenFar.add(next.id);
          alerts.push({ level: '1km', id: next.id, name: next.name, kind: next.kind, dist: next.dist });
        }
        if (canAlert && next.dist <= 300 && (prevD == null || prevD > 300) && !seenNear.has(next.id)) {
          seenNear.add(next.id);
          alerts.push({ level: '300m', id: next.id, name: next.name, kind: next.kind, dist: next.dist });
        }
        alertDist.set(next.id, next.dist);
        if (next.dist > 1600) {
          seenFar.delete(next.id);
          seenNear.delete(next.id);
        }
      }
      if (alerts.some(function (a) { return a.level === '300m'; })) {
        alerts = alerts.filter(function (a) { return a.level === '300m'; });
      }
      if (!emitAlerts) alerts = [];

      return {
        speedKmh: speedKmh,
        heading: heading,
        lat: lat,
        lng: lng,
        insides: insides,
        next: next,
        nextMode: nextMode,
        nextCorridors: nextCorridors,
        alerts: alerts
      };
    }

    return { push: push, reset: reset };
  }

  function cumulative(points) {
    var cum = [0];
    for (var i = 0; i < points.length - 1; i++) cum.push(cum[i] + haversine(points[i], points[i + 1]));
    return cum;
  }

  function pointAlong(points, dist) {
    if (!points.length) return null;
    if (dist <= points[0].along) return { lat: points[0].lat, lng: points[0].lng, along: points[0].along };
    var last = points[points.length - 1];
    if (dist >= last.along) return { lat: last.lat, lng: last.lng, along: last.along };
    var lo = 0;
    var hi = points.length - 1;
    while (lo + 1 < hi) {
      var mid = (lo + hi) >> 1;
      if (points[mid].along < dist) lo = mid;
      else hi = mid;
    }
    var a = points[lo];
    var b = points[hi];
    var span = b.along - a.along;
    var t = span > 0 ? (dist - a.along) / span : 0;
    return {
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
      along: dist
    };
  }

  function headingAlong(points, dist) {
    var end = points[points.length - 1].along;
    var a = pointAlong(points, dist);
    var b = pointAlong(points, Math.min(end, dist + 40));
    if (haversine(a, b) < 1) {
      var c = pointAlong(points, Math.max(0, dist - 40));
      return bearing(c, a);
    }
    return bearing(a, b);
  }

  function sliceDistance(coords, cum, d0, d1) {
    function at(dist) {
      if (dist <= 0) return coords[0];
      if (dist >= cum[cum.length - 1]) return coords[coords.length - 1];
      var i = 1;
      while (cum[i] < dist) i++;
      var span = cum[i] - cum[i - 1];
      var t = span > 0 ? (dist - cum[i - 1]) / span : 0;
      return {
        lat: coords[i - 1].lat + (coords[i].lat - coords[i - 1].lat) * t,
        lng: coords[i - 1].lng + (coords[i].lng - coords[i - 1].lng) * t
      };
    }
    var out = [];
    var start = at(d0);
    out.push({ lat: start.lat, lng: start.lng, along: 0 });
    for (var i = 0; i < coords.length; i++) {
      if (cum[i] > d0 + 1 && cum[i] < d1 - 1) {
        out.push({ lat: coords[i].lat, lng: coords[i].lng, along: cum[i] - d0 });
      }
    }
    var end = at(d1);
    out.push({ lat: end.lat, lng: end.lng, along: d1 - d0 });
    return out;
  }

  function nearestIndex(points, pt) {
    var best = 0;
    var bd = Infinity;
    for (var i = 0; i < points.length; i++) {
      var d = haversine(points[i], pt);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function buildSimPath(fc) {
    var features = (fc && fc.features) || [];
    var route = null;
    var kor = null;
    features.forEach(function (f) {
      var p = f.properties || {};
      if (p.kind === 'route' && p.route === 'A') route = f;
      if (p.id === 'korkuteli') kor = f;
    });
    if (!kor) return null;
    var gate = { lat: kor.geometry.coordinates[0][1], lng: kor.geometry.coordinates[0][0] };
    var tail = kor.geometry.coordinates[kor.geometry.coordinates.length - 1];
    var endPt = { lat: tail[1], lng: tail[0] };
    var coords;
    if (route) {
      coords = route.geometry.coordinates.map(function (c) { return { lat: c[1], lng: c[0] }; });
    } else {
      coords = kor.geometry.coordinates.map(function (c) { return { lat: c[1], lng: c[0] }; });
    }
    var cum = cumulative(coords);
    var gateI = nearestIndex(coords, gate);
    var endI = nearestIndex(coords, endPt);
    var d0 = Math.max(0, cum[gateI] - 3200);
    var d1 = Math.min(cum[cum.length - 1], cum[endI] + 800);
    if (d1 <= d0) { d0 = cum[gateI]; d1 = cum[endI]; }
    var points = sliceDistance(coords, cum, d0, d1);
    return { points: points, lengthM: points[points.length - 1].along, name: 'Korkuteli' };
  }

  function lineFromLatLngs(latlngs) {
    var cum = [0];
    for (var i = 0; i < latlngs.length - 1; i++) cum.push(cum[i] + haversine(latlngs[i], latlngs[i + 1]));
    var points = [];
    for (var j = 0; j < latlngs.length; j++) {
      points.push({ lat: latlngs[j].lat, lng: latlngs[j].lng, along: cum[j] });
    }
    return { latlngs: latlngs, cum: cum, lengthM: cum[cum.length - 1] || 0, points: points };
  }

  function simplifyLine(latlngs, maxPoints) {
    if (!latlngs || latlngs.length < 2) return (latlngs || []).slice();
    if (latlngs.length <= maxPoints) return latlngs.slice();
    var out = [];
    var last = latlngs.length - 1;
    var step = last / (maxPoints - 1);
    var prev = -1;
    for (var i = 0; i < maxPoints; i++) {
      var idx = Math.min(last, Math.round(i * step));
      if (idx === prev) continue;
      prev = idx;
      out.push(latlngs[idx]);
    }
    var tail = latlngs[last];
    var end = out[out.length - 1];
    if (!end || end.lat !== tail.lat || end.lng !== tail.lng) out.push(tail);
    return out;
  }

  function alongRoute(model, routeLine, thresholdM) {
    var limit = thresholdM || 170;
    var items = [];
    if (!routeLine || routeLine.lengthM < 1) return items;
    (model.radars || []).forEach(function (r) {
      var proj = projectPolyline(r, routeLine);
      if (proj.dist <= limit) {
        items.push({
          kind: 'radar',
          id: r.id,
          name: r.name,
          limit: r.limit,
          alongM: proj.along,
          road: r.road || '',
          feature: r
        });
      }
    });
    (model.corridors || []).forEach(function (c) {
      var covered = 0;
      var minAlong = Infinity;
      for (var s = 0; s < c.latlngs.length - 1; s++) {
        var a = c.latlngs[s];
        var b = c.latlngs[s + 1];
        var mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
        var mp = projectPolyline(mid, routeLine);
        var segLen = c.cum[s + 1] - c.cum[s];
        if (mp.dist <= limit) {
          covered += segLen;
          if (mp.along < minAlong) minAlong = mp.along;
        }
      }
      var ratio = c.lengthM > 0 ? covered / c.lengthM : 0;
      if (!(covered >= 1500 || (ratio >= 0.5 && covered >= 400))) return;
      items.push({
        kind: c.kind === 'corridor_egm' ? 'egm' : 'corridor',
        id: c.id,
        name: c.name,
        limit: c.limit,
        alongM: minAlong,
        publishedKm: c.publishedKm,
        minTimeLabel: c.minTimeLabel,
        lengthM: c.lengthM,
        yol: c.yol || '',
        feature: c
      });
    });
    items.sort(function (a, b) { return a.alongM - b.alongM; });
    return items;
  }

  function subsetModel(model, items) {
    var corridors = {};
    var radars = {};
    items.forEach(function (it) {
      if (it.kind === 'radar') radars[it.id] = true;
      else corridors[it.id] = true;
    });
    return {
      corridors: (model.corridors || []).filter(function (c) { return corridors[c.id]; }),
      radars: (model.radars || []).filter(function (r) { return radars[r.id]; })
    };
  }

  function coverageLimited(routeLine, coverLines, bufferM) {
    var buffer = bufferM || 8000;
    if (!routeLine || routeLine.lengthM < 5000 || !coverLines || !coverLines.length) return false;
    var step = Math.max(2000, routeLine.lengthM / 80);
    var n = 0;
    var outside = 0;
    for (var d = 0; d <= routeLine.lengthM; d += step) {
      var p = pointAlong(routeLine.points, d);
      var near = false;
      for (var i = 0; i < coverLines.length; i++) {
        if (projectPolyline(p, coverLines[i]).dist <= buffer) { near = true; break; }
      }
      n++;
      if (!near) outside++;
    }
    return n > 0 && outside / n > 0.22;
  }

  function networkLines(fc) {
    var lines = [];
    ((fc && fc.features) || []).forEach(function (f) {
      var p = f.properties || {};
      if (p.kind === 'route' && f.geometry && f.geometry.type === 'LineString') {
        var ll = f.geometry.coordinates.map(function (c) { return { lat: c[1], lng: c[0] }; });
        lines.push(lineFromLatLngs(simplifyLine(ll, 420)));
      }
    });
    return lines;
  }

  function fallbackDrivingLine(fc, start, end) {
    if (!start || !end) return null;
    var best = null;
    ((fc && fc.features) || []).forEach(function (f) {
      var p = f.properties || {};
      if (p.kind !== 'route' || !f.geometry || f.geometry.type !== 'LineString') return;
      var coords = f.geometry.coordinates.map(function (c) { return { lat: c[1], lng: c[0] }; });
      if (coords.length < 2) return;
      var a = coords[0];
      var b = coords[coords.length - 1];
      var forward = haversine(start, a) + haversine(end, b);
      var backward = haversine(start, b) + haversine(end, a);
      var reversed = backward + 3000 < forward;
      var score = reversed ? backward : forward;
      if (!best || score < best.score) {
        best = {
          score: score,
          reversed: reversed,
          name: p.name || 'Güzergah',
          line: reversed ? coords.slice().reverse() : coords.slice()
        };
      }
    });
    if (!best || best.score > 90000) return null;
    return best;
  }

  return {
    haversine: haversine,
    bearing: bearing,
    angleDiff: angleDiff,
    lerpAngle: lerpAngle,
    parseDuration: parseDuration,
    buildModel: buildModel,
    createSession: createSession,
    pointAlong: pointAlong,
    headingAlong: headingAlong,
    buildSimPath: buildSimPath,
    lineFromLatLngs: lineFromLatLngs,
    simplifyLine: simplifyLine,
    alongRoute: alongRoute,
    subsetModel: subsetModel,
    coverageLimited: coverageLimited,
    networkLines: networkLines,
    fallbackDrivingLine: fallbackDrivingLine,
    projectPolyline: projectPolyline,
    ENTER_M: ENTER_M
  };
});

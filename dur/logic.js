/* DUR risk bekçisi — salt hesap. Emir göndermez, hesaba dokunmaz. */
(function (root) {
  "use strict";

  var LOT_UNIT = 0.01;
  var RISK_PCT = 0.02;
  var DAILY_PCT = 0.05;
  var MAX_LOSSES = 2;
  var MAX_OPEN = 1;
  var TZ = "Europe/Istanbul";

  function dollarsPerPrice(lot) {
    var n = Number(lot);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n / LOT_UNIT;
  }

  function todayId(now) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(now || new Date());
  }

  function formatTsTime(d) {
    d = d instanceof Date ? d : new Date(d);
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("tr-TR", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(d);
  }

  function formatTsDate(d) {
    d = d instanceof Date ? d : new Date(d);
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("tr-TR", {
      timeZone: TZ,
      day: "numeric",
      month: "short",
      year: "numeric"
    }).format(d);
  }

  function parseNum(s) {
    if (s == null) return null;
    var t = String(s).trim();
    if (!t) return null;
    t = t.replace(/\s/g, "");
    if (t.indexOf(",") !== -1 && t.indexOf(".") !== -1) {
      if (t.lastIndexOf(",") > t.lastIndexOf(".")) t = t.replace(/\./g, "").replace(",", ".");
      else t = t.replace(/,/g, "");
    } else if (t.indexOf(",") !== -1) {
      t = t.replace(",", ".");
    }
    var n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  function cents(n) {
    return Math.round(Number(n) * 100);
  }

  function fromCents(c) {
    return c / 100;
  }

  function maxRiskUsd(kasa) {
    if (kasa == null || !(kasa > 0)) return null;
    return fromCents(cents(kasa * RISK_PCT));
  }

  function dailyBudgetUsd(kasa) {
    if (kasa == null || !(kasa > 0)) return null;
    return fromCents(cents(kasa * DAILY_PCT));
  }

  function maxStopDistance(kasa, lot) {
    var risk = maxRiskUsd(kasa);
    var per = dollarsPerPrice(lot);
    if (risk == null || per == null) return null;
    return fromCents(cents(risk / per));
  }

  function stopDistance(entry, stop) {
    if (entry == null || stop == null) return null;
    if (!Number.isFinite(entry) || !Number.isFinite(stop)) return null;
    return fromCents(cents(Math.abs(entry - stop)));
  }

  function tradeRiskUsd(entry, stop, lot) {
    var d = stopDistance(entry, stop);
    var per = dollarsPerPrice(lot);
    if (d == null || per == null) return null;
    return fromCents(cents(d * per));
  }

  function maxStopLevel(entry, side, kasa, lot) {
    var d = maxStopDistance(kasa, lot);
    if (d == null || entry == null || !Number.isFinite(entry)) return null;
    if (side === "buy") return fromCents(cents(entry - d));
    if (side === "sell") return fromCents(cents(entry + d));
    return null;
  }

  function stopSideOk(side, entry, stop) {
    if (entry == null || stop == null) return null;
    if (side === "buy") return stop < entry;
    if (side === "sell") return stop > entry;
    return null;
  }

  function isStopMissing(trade) {
    return !!(trade && trade.result === "open" && (trade.stop == null || trade.stop === ""));
  }

  function estimatedLoss(trade) {
    return tradeRiskUsd(trade.entry, trade.stop, trade.lot || LOT_UNIT);
  }

  function todayPnlCents(today) {
    var c = 0;
    var known = true;
    var missingLoss = false;
    for (var i = 0; i < today.length; i++) {
      var t = today[i];
      if (t.result === "open" || t.result === "be") continue;
      if (t.pnl == null || !Number.isFinite(Number(t.pnl))) {
        if (t.result === "loss") {
          var est = estimatedLoss(t);
          if (est != null) c -= cents(est);
          else {
            known = false;
            missingLoss = true;
          }
        } else if (t.result === "win") {
          known = false;
        }
      } else {
        c += cents(t.pnl);
      }
    }
    return { cents: c, known: known, missingLoss: missingLoss };
  }

  function summarize(state, now) {
    now = now || new Date();
    var day = todayId(now);
    var kasa = state && typeof state.kasa === "number" && state.kasa > 0 ? state.kasa : null;
    var trades = state && Array.isArray(state.trades) ? state.trades : [];
    var today = trades.filter(function (t) { return t.day === day; });
    var open = trades.filter(function (t) { return t.result === "open"; });
    var todayLosses = today.filter(function (t) { return t.result === "loss"; }).length;
    var pnl = todayPnlCents(today);
    var budget = dailyBudgetUsd(kasa);
    var hitLosses = todayLosses >= MAX_LOSSES;
    var hitDaily = budget != null && pnl.cents <= -cents(budget);
    var noStop = open.some(isStopMissing);
    return {
      day: day,
      kasa: kasa,
      today: today,
      open: open,
      openCount: open.length,
      todayLosses: todayLosses,
      dailyPnl: fromCents(pnl.cents),
      pnlKnown: pnl.known,
      missingLoss: pnl.missingLoss,
      maxRisk: maxRiskUsd(kasa),
      dailyBudget: budget,
      maxStopDist: maxStopDistance(kasa, (state && state.lastLot) || LOT_UNIT),
      maxStopDist01: maxStopDistance(kasa, LOT_UNIT),
      stopped: hitLosses || hitDaily,
      hitLosses: hitLosses,
      hitDaily: hitDaily,
      noStop: noStop,
      tooManyOpen: open.length > MAX_OPEN,
      canOpen: open.length < MAX_OPEN,
      lotHint500: kasa != null && kasa >= 500
    };
  }

  function fmtUsd(n, digits) {
    if (digits == null) digits = 2;
    if (n == null || !Number.isFinite(n)) return "—";
    var sign = n < 0 ? "−" : "";
    return sign + "$" + Math.abs(n).toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  function fmtPrice(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return n.toFixed(2);
  }

  function parseLive(j) {
    if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    var bid = Number(j.bid);
    var ask = Number(j.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
    var spreadPoints = Number(j.spreadPoints);
    var point = Number(j.point);
    if (!Number.isFinite(point) || point <= 0) point = 0.01;
    var spread = Number.isFinite(spreadPoints) ? fromCents(cents(spreadPoints * point)) : fromCents(cents(ask - bid));
    return {
      symbol: typeof j.symbol === "string" && j.symbol ? j.symbol : "GOLD",
      bid: bid,
      ask: ask,
      spread: spread,
      spreadPoints: Number.isFinite(spreadPoints) ? spreadPoints : null,
      serverTime: typeof j.serverTime === "string" ? j.serverTime : null,
      gmtTime: typeof j.gmtTime === "string" ? j.gmtTime : null
    };
  }

  function parseMt5Time(s) {
    if (!s || typeof s !== "string") return null;
    var m = s.trim().match(/^(\d{4})[.\-](\d{2})[.\-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return new Date(Date.UTC(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6] || 0)
    ));
  }

  function liveTimeTsi(live) {
    if (!live) return null;
    var gmt = parseMt5Time(live.gmtTime);
    if (gmt) return gmt;
    // XM sunucu saati = TSİ − 1 saat = UTC+2 (İstanbul UTC+3, yaz saati yok).
    var srv = parseMt5Time(live.serverTime);
    if (srv) return new Date(srv.getTime() - 2 * 60 * 60 * 1000);
    return null;
  }

  var api = {
    LOT_UNIT: LOT_UNIT,
    RISK_PCT: RISK_PCT,
    DAILY_PCT: DAILY_PCT,
    MAX_LOSSES: MAX_LOSSES,
    MAX_OPEN: MAX_OPEN,
    TZ: TZ,
    dollarsPerPrice: dollarsPerPrice,
    todayId: todayId,
    formatTsTime: formatTsTime,
    formatTsDate: formatTsDate,
    parseNum: parseNum,
    cents: cents,
    fromCents: fromCents,
    maxRiskUsd: maxRiskUsd,
    dailyBudgetUsd: dailyBudgetUsd,
    maxStopDistance: maxStopDistance,
    stopDistance: stopDistance,
    tradeRiskUsd: tradeRiskUsd,
    maxStopLevel: maxStopLevel,
    stopSideOk: stopSideOk,
    isStopMissing: isStopMissing,
    estimatedLoss: estimatedLoss,
    summarize: summarize,
    fmtUsd: fmtUsd,
    fmtPrice: fmtPrice,
    parseLive: parseLive,
    parseMt5Time: parseMt5Time,
    liveTimeTsi: liveTimeTsi
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.DurLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

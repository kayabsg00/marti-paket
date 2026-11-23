/* DUR risk bekçisi — arayüz. Emir göndermez, yalnızca bu tarayıcıda saklar. */
(function () {
  "use strict";
  var L = window.DurLogic;
  var KEY = "grokay-dur-v1";
  var state = load();
  var calcSide = "buy";
  var logSide = "buy";
  var logRes = "open";
  var liveTimer = null;
  var liveInfo = null;
  var liveErr = null;

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return { kasa: null, liveUrl: "", lastLot: 0.01, trades: [] };
      var s = JSON.parse(raw);
      return {
        kasa: typeof s.kasa === "number" && s.kasa > 0 ? s.kasa : null,
        liveUrl: typeof s.liveUrl === "string" ? s.liveUrl : "",
        lastLot: typeof s.lastLot === "number" && s.lastLot > 0 ? s.lastLot : 0.01,
        trades: Array.isArray(s.trades) ? s.trades : []
      };
    } catch (e) {
      return { kasa: null, liveUrl: "", lastLot: 0.01, trades: [] };
    }
  }

  function save() {
    localStorage.setItem(KEY, JSON.stringify({
      kasa: state.kasa,
      liveUrl: state.liveUrl || "",
      lastLot: state.lastLot || 0.01,
      trades: state.trades
    }));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function $(id) { return document.getElementById(id); }

  function setSeg(groupSelector, attr, value) {
    document.querySelectorAll(groupSelector).forEach(function (b) {
      b.classList.toggle("on", b.getAttribute(attr) === value);
    });
  }

  function render() {
    var sum = L.summarize(state);
    var dateLine = L.formatTsDate(new Date()) + " · TSİ";
    $("dateLine").textContent = dateLine;

    var banner = $("banner");
    banner.className = "banner";
    document.body.classList.remove("stopped", "warn-stop");
    document.documentElement.style.background = "";
    var theme = "#0a0b0e";

    if (sum.stopped) {
      document.body.classList.add("stopped");
      banner.classList.add("bad");
      var why = [];
      if (sum.hitLosses) why.push("bugün " + sum.todayLosses + " zarar");
      if (sum.hitDaily) why.push("günlük kayıp " + L.fmtUsd(sum.dailyPnl) + " (limit " + L.fmtUsd(sum.dailyBudget) + ")");
      banner.innerHTML = "BUGÜN BİTTİ, ekranı kapat<span class=\"why\">" + why.join(" · ") + "</span>";
      theme = "#5a1010";
    } else if (sum.noStop) {
      document.body.classList.add("warn-stop");
      banner.classList.add("bad");
      banner.innerHTML = "STOP YOK<span class=\"why\">Açık işlemde stop görünmüyor. Hemen MT5’e stop koy, sonra buraya yaz.</span>";
      theme = "#5a1010";
    } else if (sum.tooManyOpen) {
      banner.classList.add("warn");
      banner.textContent = "Aynı anda birden fazla açık işlem var. Fazlasını kapat.";
      theme = "#2a220c";
    } else if (state.kasa == null) {
      banner.classList.add("warn");
      banner.textContent = "Önce kasanı yaz. Limitler ona göre hesaplanır.";
    } else {
      banner.classList.add("ok");
      var leftLoss = L.MAX_LOSSES - sum.todayLosses;
      var leftUsd = sum.dailyBudget != null ? L.fromCents(L.cents(sum.dailyBudget) + L.cents(Math.min(0, sum.dailyPnl))) : null;
      banner.textContent = "Devam edebilirsin · kalan " + leftLoss + " zarar hakkı" +
        (leftUsd != null ? ", günlük " + L.fmtUsd(leftUsd) : "");
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme);

    var kasaInput = $("kasaInput");
    if (document.activeElement !== kasaInput) {
      kasaInput.value = state.kasa != null ? String(state.kasa) : "";
    }
    var hint = $("kasaHint");
    if (state.kasa == null) {
      hint.textContent = "Kasa sende. Limitler buraya yazdığın tutara göre hesaplanır, cihazda saklanır.";
    } else if (state.kasa >= 500) {
      hint.textContent = "Kasa $500’ı geçti. İstersen 0,02 lot düşünebilirsin; risk yine %2’yi aşmasın.";
    } else {
      hint.textContent = "Lot 0,01 kalsın. Kasa $500’ı geçince 0,02 lot konuşuruz.";
    }

    var metrics = [];
    metrics.push(metric("İşlem riski (%2)", L.fmtUsd(sum.maxRisk)));
    metrics.push(metric("Max stop (0,01 lot)", sum.maxStopDist01 != null ? L.fmtUsd(sum.maxStopDist01) : "—"));
    metrics.push(metric("Günlük hak (%5)", L.fmtUsd(sum.dailyBudget)));
    var lossLabel = sum.todayLosses + " / " + L.MAX_LOSSES + " zarar";
    var pnlLabel = L.fmtUsd(sum.dailyPnl);
    var lossClass = sum.hitLosses || sum.hitDaily ? "bad" : (sum.todayLosses === 1 ? "warn" : "");
    metrics.push(metric("Bugün", pnlLabel + " · " + lossLabel, lossClass, true));
    if (sum.openCount) {
      metrics.push(metric("Açık işlem", String(sum.openCount) + " / " + L.MAX_OPEN, sum.tooManyOpen || sum.noStop ? "bad" : "warn", true));
    }
    $("metrics").innerHTML = metrics.join("");

    renderLive();
    renderCalc();

    if (document.activeElement !== $("logLot") && !$("logLot").value) $("logLot").value = String(state.lastLot || 0.01);
    $("logWarn").hidden = true;

    renderLists(sum);
  }

  function metric(k, v, cls, span) {
    return '<div class="metric' + (cls ? " " + cls : "") + (span ? " span2" : "") + '"><div class="k">' + esc(k) + '</div><div class="v' + (String(v).length > 14 ? " sm" : "") + '">' + esc(v) + "</div></div>";
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderLive() {
    var box = $("liveBox");
    if (liveInfo) {
      var t = L.liveTimeTsi(liveInfo);
      var when = t ? (L.formatTsTime(t) + " TSİ") : (liveInfo.serverTime || "");
      box.className = "live-box";
      box.innerHTML = '<div class="live-px">' + esc(liveInfo.symbol) + "  " +
        L.fmtPrice(liveInfo.bid) + " / " + L.fmtPrice(liveInfo.ask) + "</div>" +
        '<div class="live-meta">Spread ' + L.fmtUsd(liveInfo.spread) +
        (liveInfo.spreadPoints != null ? " (" + liveInfo.spreadPoints + " puan)" : "") +
        (when ? " · " + when : "") + " · salt okunur</div>";
    } else if (state.liveUrl && liveErr) {
      box.className = "live-err";
      box.textContent = "Köprüye ulaşılamadı. Manuel defter çalışmaya devam eder. (" + liveErr + ")";
    } else if (state.liveUrl) {
      box.className = "live-off";
      box.textContent = "Köprü deneniyor…";
    } else {
      box.className = "live-off";
      box.textContent = "Manuel mod — canlı fiyat yok. Hesap ve defter yine çalışır.";
    }
    if (document.activeElement !== $("liveUrl")) $("liveUrl").value = state.liveUrl || "";
  }

  function renderCalc() {
    var entry = L.parseNum($("calcEntry").value);
    var stop = L.parseNum($("calcStop").value);
    var lot = L.parseNum($("calcLot").value) || state.lastLot || 0.01;
    var parts = [];
    var dist = L.stopDistance(entry, stop);
    var risk = L.tradeRiskUsd(entry, stop, lot);
    var maxD = L.maxStopDistance(state.kasa, lot);
    var maxLv = L.maxStopLevel(entry, calcSide, state.kasa, lot);
    var maxR = L.maxRiskUsd(state.kasa);
    if (dist != null) parts.push(row("Stop mesafesi", L.fmtUsd(dist)));
    if (risk != null) parts.push(row("Bu işlemde risk", L.fmtUsd(risk)));
    parts.push(row("İzinli risk (%2)", L.fmtUsd(maxR)));
    if (maxD != null) parts.push(row("Max mesafe (" + lot + " lot)", L.fmtUsd(maxD)));
    if (maxLv != null) parts.push(row("Max stop seviyesi", L.fmtPrice(maxLv)));
    var stamp = "";
    if (state.kasa == null) {
      stamp = '<div class="stamp warn">KASA GİR, LİMİT HESAPLANSIN</div>';
    } else if (risk != null) {
      var over = L.cents(risk) > L.cents(maxR);
      var sideOk = L.stopSideOk(calcSide, entry, stop);
      var extra = "";
      if (sideOk === false) extra = " · stop yönü ters görünüyor";
      stamp = over
        ? '<div class="stamp bad">RİSK FAZLA' + extra + "</div>"
        : '<div class="stamp ok">UYGUN' + extra + "</div>";
    } else if (entry != null && maxLv != null) {
      stamp = '<div class="stamp ok">Max stop: ' + L.fmtPrice(maxLv) + "</div>";
    }
    if (lot > 0.01 && state.kasa != null && state.kasa < 500) {
      stamp += '<p class="hint">Kasa henüz $500 altında. 0,01 lot daha güvenli.</p>';
    }
    $("calcOut").innerHTML = parts.join("") + stamp;
  }

  function row(k, v) {
    return '<div class="calc-row"><span>' + esc(k) + "</span><span>" + esc(v) + "</span></div>";
  }

  function tradeLine(t) {
    var side = t.side === "sell" ? "Satış" : "Alış";
    var sideCls = t.side === "sell" ? "side-sell" : "side-buy";
    var res = { open: "Açık", win: "Kazanç", loss: "Zarar", be: "Sıfır" }[t.result] || t.result;
    var pnl = "";
    if (t.result === "open") pnl = "";
    else if (t.result === "be") pnl = " · $0.00";
    else if (t.pnl != null) pnl = " · " + L.fmtUsd(t.pnl);
    else if (t.result === "loss") {
      var est = L.estimatedLoss(t);
      pnl = est != null ? " · ~" + L.fmtUsd(-est) : " · tutar yok";
    }
    var stopTxt = t.stop == null ? "STOP YOK" : "SL " + L.fmtPrice(t.stop);
    var cls = L.isStopMissing(t) ? " item nostop" : "";
    return '<button type="button" class="item' + cls + '" data-id="' + esc(t.id) + '">' +
      '<div class="row1"><span class="' + sideCls + '">' + side + " " + L.fmtPrice(t.entry) + "</span><span class=\"" +
      (t.result === "win" || (t.pnl != null && t.pnl > 0) ? "pnl-pos" : t.result === "loss" || (t.pnl != null && t.pnl < 0) ? "pnl-neg" : "") +
      '">' + res + pnl + "</span></div>" +
      '<div class="row2">' + stopTxt + " · " + (t.lot || 0.01) + " lot · " +
      (t.at ? L.formatTsTime(t.at) : "") + " TSİ</div></button>";
  }

  function renderLists(sum) {
    var today = sum.today.slice().sort(function (a, b) { return (b.at || "").localeCompare(a.at || ""); });
    $("todayList").innerHTML = today.length ? today.map(tradeLine).join("") :
      '<p class="empty">Bugün henüz işlem yok.</p>';

    var older = state.trades.filter(function (t) { return t.day !== sum.day; })
      .sort(function (a, b) { return (b.day + (b.at || "")).localeCompare(a.day + (a.at || "")); });
    var hist = $("histCard");
    if (!older.length) { hist.hidden = true; $("histList").innerHTML = ""; return; }
    hist.hidden = false;
    var groups = {};
    older.forEach(function (t) {
      (groups[t.day] || (groups[t.day] = [])).push(t);
    });
    var html = Object.keys(groups).sort().reverse().map(function (day) {
      var list = groups[day];
      var pnl = 0;
      list.forEach(function (t) {
        if (t.result === "be" || t.result === "open") return;
        if (t.pnl != null) pnl += t.pnl;
        else if (t.result === "loss") {
          var est = L.estimatedLoss(t);
          if (est != null) pnl -= est;
        }
      });
      return "<p class=\"hint\">" + esc(day) + " · " + L.fmtUsd(pnl) + "</p>" + list.map(tradeLine).join("");
    }).join("");
    $("histList").innerHTML = html;
  }

  function saveKasa() {
    var n = L.parseNum($("kasaInput").value);
    if (n == null || n <= 0) {
      alert("Geçerli bir kasa tutarı yaz.");
      return;
    }
    state.kasa = L.fromCents(L.cents(n));
    save();
    render();
  }

  function addTrade() {
    var entry = L.parseNum($("logEntry").value);
    var stopRaw = $("logStop").value;
    var stop = L.parseNum(stopRaw);
    var lot = L.parseNum($("logLot").value) || 0.01;
    var pnl = L.parseNum($("logPnl").value);
    var warn = $("logWarn");
    if (entry == null) {
      warn.hidden = false;
      warn.textContent = "Giriş fiyatını yaz.";
      return;
    }
    if (lot <= 0) {
      warn.hidden = false;
      warn.textContent = "Lot 0,01 veya üstü olsun.";
      return;
    }
    var sum = L.summarize(state);
    if (logRes === "open" && !sum.canOpen) {
      warn.hidden = false;
      warn.textContent = sum.stopped
        ? "BUGÜN BİTTİ — yeni açık işlem yazma, ekranı kapat."
        : "Aynı anda tek açık işlem. Önce mevcut olanı kapat.";
      return;
    }
    if (logRes === "open" && stop == null) {
      if (!confirm("Stop yok. Yine de açık işlem olarak kaydedeyim mi? Sayfa kırmızı uyarı verecek.")) return;
    }
    if (stop != null && L.stopSideOk(logSide, entry, stop) === false) {
      if (!confirm("Stop yönü ters görünüyor (alışta stop girişin altında, satışta üstünde olmalı). Yine de kaydedeyim mi?")) return;
    }
    if (logRes === "loss" && pnl == null && stop != null) {
      pnl = -L.estimatedLoss({ entry: entry, stop: stop, lot: lot });
    }
    if ((logRes === "win" || logRes === "loss") && pnl == null) {
      warn.hidden = false;
      warn.textContent = "Kapalı işlem için sonuç tutarını yaz (zarar eksi, ör. -6).";
      return;
    }
    if (logRes === "be") pnl = 0;
    if (logRes === "open") pnl = null;

    state.trades.push({
      id: uid(),
      day: L.todayId(),
      at: new Date().toISOString(),
      side: logSide,
      entry: entry,
      stop: stop,
      lot: lot,
      result: logRes,
      pnl: pnl
    });
    state.lastLot = lot;
    save();
    $("logEntry").value = "";
    $("logStop").value = "";
    $("logPnl").value = "";
    logRes = "open";
    setSeg("#logCard [data-res]", "data-res", "open");
    render();
  }

  function openSheet(id) {
    var t = state.trades.find(function (x) { return x.id === id; });
    if (!t) return;
    var sheet = $("sheet");
    $("sheetTitle").textContent = (t.side === "sell" ? "Satış" : "Alış") + " " + L.fmtPrice(t.entry);
    var body = "";
    if (t.result === "open") {
      body += '<label for="sheetPnl">Kapanış tutarı $</label><input id="sheetPnl" inputmode="decimal" placeholder="zarar eksi, kazanç artı">';
      if (t.stop == null) {
        body += '<label for="sheetStop">Stop ekle</label><input id="sheetStop" inputmode="decimal">';
      }
    } else {
      body += "<p class=\"hint\">Sonuç: " + t.result + (t.pnl != null ? " · " + L.fmtUsd(t.pnl) : "") + "</p>";
    }
    $("sheetBody").innerHTML = body;
    var acts = "";
    if (t.result === "open") {
      acts += '<button type="button" class="btn good" data-act="win">Kazançla kapat</button>';
      acts += '<button type="button" class="btn danger" data-act="loss">Zararla kapat</button>';
      acts += '<button type="button" class="btn ghost" data-act="be">Sıfırla kapat</button>';
      if (t.stop == null) acts += '<button type="button" class="btn prim" data-act="addstop">Stopu kaydet</button>';
    }
    acts += '<button type="button" class="btn danger" data-act="del">İşlemi sil</button>';
    $("sheetActions").innerHTML = acts;
    $("sheetActions").onclick = function (e) {
      var btn = e.target.closest("[data-act]");
      if (!btn) return;
      var act = btn.getAttribute("data-act");
      if (act === "del") {
        if (!confirm("Bu işlem silinsin mi?")) return;
        state.trades = state.trades.filter(function (x) { return x.id !== id; });
        save(); closeSheet(); render(); return;
      }
      if (act === "addstop") {
        var st = L.parseNum($("sheetStop") && $("sheetStop").value);
        if (st == null) { alert("Stop fiyatını yaz."); return; }
        t.stop = st;
        save(); closeSheet(); render(); return;
      }
      var pnl = $("sheetPnl") ? L.parseNum($("sheetPnl").value) : null;
      if (act === "be") pnl = 0;
      if (act === "loss" && pnl == null) {
        var est = L.estimatedLoss(t);
        pnl = est != null ? -est : null;
      }
      if ((act === "win" || act === "loss") && pnl == null) {
        alert("Kapanış tutarını yaz.");
        return;
      }
      t.result = act;
      t.pnl = pnl;
      t.closedAt = new Date().toISOString();
      save(); closeSheet(); render();
    };
    sheet.hidden = false;
  }

  function closeSheet() {
    $("sheet").hidden = true;
    $("sheetActions").onclick = null;
  }

  function pollLive() {
    var url = (state.liveUrl || "").trim();
    if (!url) { liveInfo = null; liveErr = null; renderLive(); return; }
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 4000);
    fetch(url, { cache: "no-store", mode: "cors", signal: ctrl && ctrl.signal, credentials: "omit" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (j) {
        var p = L.parseLive(j);
        if (!p) throw new Error("beklenen bid/ask yok");
        liveInfo = p;
        liveErr = null;
        renderLive();
      })
      .catch(function (e) {
        liveInfo = null;
        liveErr = (e && e.name === "AbortError") ? "zaman aşımı" : "erişilemedi";
        renderLive();
      })
      .then(function () { clearTimeout(to); });
  }

  function startLive() {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
    if (!(state.liveUrl || "").trim()) { liveInfo = null; liveErr = null; return; }
    pollLive();
    liveTimer = setInterval(pollLive, 8000);
  }

  $("btnKasa").addEventListener("click", saveKasa);
  $("kasaInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") saveKasa();
  });

  $("sideBuy").addEventListener("click", function () { calcSide = "buy"; setSeg("#calcCard [data-side]", "data-side", "buy"); renderCalc(); });
  $("sideSell").addEventListener("click", function () { calcSide = "sell"; setSeg("#calcCard [data-side]", "data-side", "sell"); renderCalc(); });
  ["calcEntry", "calcStop", "calcLot"].forEach(function (id) {
    $(id).addEventListener("input", renderCalc);
  });
  $("btnToLog").addEventListener("click", function () {
    $("logEntry").value = $("calcEntry").value;
    $("logStop").value = $("calcStop").value;
    $("logLot").value = $("calcLot").value || "0.01";
    logSide = calcSide;
    setSeg("#logCard [data-logside]", "data-logside", logSide);
    $("logEntry").focus();
  });

  $("logBuy").addEventListener("click", function () { logSide = "buy"; setSeg("#logCard [data-logside]", "data-logside", "buy"); });
  $("logSell").addEventListener("click", function () { logSide = "sell"; setSeg("#logCard [data-logside]", "data-logside", "sell"); });
  document.querySelectorAll("#logCard [data-res]").forEach(function (b) {
    b.addEventListener("click", function () {
      logRes = b.getAttribute("data-res");
      setSeg("#logCard [data-res]", "data-res", logRes);
    });
  });
  $("btnLog").addEventListener("click", addTrade);

  document.addEventListener("click", function (e) {
    var item = e.target.closest(".item[data-id]");
    if (item) openSheet(item.getAttribute("data-id"));
  });
  $("btnSheetClose").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", function (e) {
    if (e.target.id === "sheet") closeSheet();
  });

  $("btnLive").addEventListener("click", function () {
    var v = $("liveUrl").value.trim();
    if (v && !/^https?:\/\//i.test(v)) {
      alert("Adres http veya https ile başlamalı.");
      return;
    }
    state.liveUrl = v;
    save();
    startLive();
    render();
  });

  if (state.lastLot) {
    $("calcLot").value = String(state.lastLot);
    $("logLot").value = String(state.lastLot);
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(function () {});
  }

  render();
  startLive();
  setInterval(function () {
    var el = document.activeElement;
    var tag = el && el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    render();
  }, 30000);
})();

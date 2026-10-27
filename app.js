/* Weekend Hopper: loads data/*.json (refreshed nightly by GitHub Actions) and plans football trips. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function getJSON(url, fallback) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); })
      .catch(function (e) { if (fallback !== undefined) return fallback; throw e; });
  }
  Promise.all([
    getJSON('data/config.json'), getJSON('data/fixtures.json'), getJSON('data/venues.json', { venues: {} }),
    getJSON('data/travel.json', {}), getJSON('data/world.json', null), getJSON('data/world-extra.json', null)
  ]).then(function (d) { start(d[0], d[1], d[2], d[3], d[4], d[5]); })
    .catch(function (e) {
      $('plans').innerHTML = '<div class="empty">The fixture data could not be loaded. Try reloading the page.</div>';
      $('dataNote').textContent = String(e);
    });

  function start(CFG, FIX, VEN, TRAVEL, WORLD, WORLD_EXTRA) {
    var HUBS = CFG.hubs, RAIL = CFG.rail, PAIRS = CFG.pairs;
    var GR = Object.assign({}, VEN.venues || {}, CFG.grounds);
    var HD = {}; CFG.highDemand.forEach(function (n) { HD[n] = 1; });
    var TH = TRAVEL.hub || {}, TG = TRAVEL.gg || {};
    var COUNTRY = { ITA: 'Italy', ENG: 'England', WAL: 'Wales', SCO: 'Scotland', NIR: 'Northern Ireland', NED: 'Netherlands', BEL: 'Belgium',
      SUI: 'Switzerland', GER: 'Germany', FRA: 'France', ESP: 'Spain', POR: 'Portugal', AUT: 'Austria', DEN: 'Denmark', IRL: 'Ireland', LUX: 'Luxembourg' };
    var MAPNAME = { ITA: 'Italy', ENG: 'United Kingdom', WAL: 'United Kingdom', SCO: 'United Kingdom', NIR: 'United Kingdom', NED: 'Netherlands',
      BEL: 'Belgium', SUI: 'Switzerland', GER: 'Germany', FRA: 'France', ESP: 'Spain', POR: 'Portugal', AUT: 'Austria', DEN: 'Denmark', IRL: 'Ireland', LUX: 'Luxembourg' };
    function cname(cc) { return COUNTRY[cc] || cc; }
    var DUR = 110, BUF = 30, ASSUME_KO = 15 * 60;

    var FX = [];
    FIX.fix.forEach(function (r) {
      if (!GR[r[5]]) return;
      var h = FIX.teams[r[2]], a = FIX.teams[r[3]];
      FX.push({ date: r[0], t: r[1], h: h, a: a, lg: FIX.leagues[r[4]], g: r[5], fl: r[6], sc: r[7], hd: !!HD[h], k: r[0] + '|' + h + '|' + a });
    });
    var FX_BY_KEY = {}; FX.forEach(function (f) { FX_BY_KEY[f.k] = f; });

    /* ---------- helpers ---------- */
    function toMin(t) { var p = t.split(':'); return +p[0] * 60 + +p[1]; }
    function koMin(f) { return f.t && f.fl < 2 ? toMin(f.t) : ASSUME_KO; }
    function hhmm(m) { m = ((Math.round(m) % 1440) + 1440) % 1440; var h = Math.floor(m / 60), mm = m % 60; return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm; }
    function fmtDur(m) { m = Math.round(m); if (m < 60) return m + ' min'; var h = Math.floor(m / 60), r = m % 60; return h + 'h' + (r ? ' ' + (r < 10 ? '0' : '') + r + 'm' : ''); }
    function r5(x) { return Math.max(5, Math.round(x / 5) * 5); }
    function km(a, b) {
      var rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
      var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
      return 2 * 6371 * Math.asin(Math.sqrt(s));
    }
    function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
    function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5); }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

    /* ---------- travel times: real (Transitous) first, estimate otherwise ---------- */
    function railCC(reg, c1, c2, a, b) {
      if (c1 === c2) return 0;
      var d = PAIRS[c1 + '|' + c2] || PAIRS[c2 + '|' + c1];
      if (d) return d;
      var t1 = RAIL[reg][c1], t2 = RAIL[reg][c2];
      return Math.min(t1 + t2 + (t1 && t2 ? 10 : 0), 30 + km(a, b));
    }
    function hubEntry(hub, gk) { return TH[hub] && TH[hub][gk]; }
    function travelHG(hub, gk) {
      var e = hubEntry(hub, gk); if (e && e.m) return e.m;
      var g = GR[gk];
      if (g.rc && RAIL[hub] && RAIL[hub][g.rc] != null) return r5(RAIL[hub][g.rc] + g.acc);
      return r5(25 + km(HUBS[hub], g) * 0.9);
    }
    function realHG(hub, gk) { var e = hubEntry(hub, gk); return !!(e && e.m); }
    function ggEntry(a, b) { return TG[a + '|' + b] || TG[b + '|' + a]; }
    function travelGG(g1, g2) {
      if (g1 === g2) return 0;
      var e = ggEntry(g1, g2); if (e && e.m) return e.m;
      var a = GR[g1], b = GR[g2];
      if (a.rc && b.rc && a.r === b.r && RAIL[a.r]) {
        if (a.rc === b.rc) return r5(10 + 0.7 * (a.acc + b.acc));
        return r5(a.acc + railCC(a.r, a.rc, b.rc, a, b) + b.acc);
      }
      return r5(25 + km(a, b));
    }
    function realGG(a, b) { var e = ggEntry(a, b); return !!(e && e.m); }
    function lateTrouble(hub, gk, endMin, backMin) {
      var e = hubEntry(hub, gk);
      if (e && typeof e.n === 'boolean' && endMin >= 22 * 60 + 30) {
        if (!e.n) return 'No late train back found after 22:30';
        if (e.last && endMin + 15 > toMin(e.last) + (toMin(e.last) < 6 * 60 ? 1440 : 0)) return 'Last connection back leaves around ' + e.last;
        return '';
      }
      return endMin + backMin >= 24 * 60 ? 'You get back after midnight, check the last train' : '';
    }

    /* ---------- planning ---------- */
    function collected(pins, today) {
      var g = {}, t = {}, c = {};
      pins.forEach(function (p) { if (p.date <= today && GR[p.g]) { g[p.g] = 1; t[p.h] = 1; t[p.a] = 1; c[GR[p.g].cc] = 1; } });
      return { g: g, t: t, c: c };
    }
    function pairOk(f1, f2) {
      if (f1.date !== f2.date) return true;
      if (f1.fl || f2.fl || f1.g === f2.g) return false;
      return koMin(f2) - (koMin(f1) + DUR) >= travelGG(f1.g, f2.g) + BUF;
    }
    function sortFx(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : koMin(a) - koMin(b); }
    function buildPlan(ms, hub, sets) {
      ms = ms.slice().sort(sortFx);
      var days = [], travel = 0, late = false, byDate = {};
      ms.forEach(function (m) { (byDate[m.date] = byDate[m.date] || []).push(m); });
      Object.keys(byDate).sort().forEach(function (date) {
        var list = byDate[date];
        var items = list.map(function (m, i) {
          var it = { f: m };
          if (i === 0) {
            it.legMin = travelHG(hub, m.g); it.real = realHG(hub, m.g); it.fromName = HUBS[hub].station; it.fromQ = HUBS[hub].station;
            it.leaveBy = koMin(m) - BUF - it.legMin;
          } else {
            var p = list[i - 1]; it.legMin = travelGG(p.g, m.g); it.real = realGG(p.g, m.g); it.fromName = GR[p.g].n; it.fromQ = GR[p.g].n + ', ' + GR[p.g].c;
            it.spare = koMin(m) - (koMin(p) + DUR) - it.legMin - BUF;
          }
          travel += it.legMin;
          return it;
        });
        var last = list[list.length - 1], back = travelHG(hub, last.g);
        travel += back;
        var trouble = lateTrouble(hub, last.g, koMin(last) + DUR, back);
        if (trouble) late = true;
        days.push({ date: date, items: items, back: back, backReal: realHG(hub, last.g), backFromQ: GR[last.g].n + ', ' + GR[last.g].c, trouble: trouble });
      });
      var gs = {}, cs = {}, ts = {}, prov = 0, hd = 0;
      ms.forEach(function (m) {
        if (!sets.g[m.g]) gs[m.g] = 1;
        if (!sets.c[GR[m.g].cc]) cs[GR[m.g].cc] = 1;
        if (!sets.t[m.h]) ts[m.h] = 1;
        if (!sets.t[m.a]) ts[m.a] = 1;
        if (m.fl) prov++;
        if (m.hd) hd++;
      });
      var newG = Object.keys(gs).length, newC = Object.keys(cs).length, newT = Object.keys(ts).length;
      var score = newG * 10 + newC * 6 + newT * 1.5 + ms.length * 2 - (travel / 60) * 3 - prov * 3 - hd * 2 - (late ? 4 : 0);
      return { ms: ms, keys: ms.map(function (m) { return m.k; }), days: days, travel: travel, late: late, newG: newG, newC: newC, newT: newT, score: score };
    }
    function findPlans(hub, from, to, maxT, maxM, pins, today) {
      var sets = collected(pins, today);
      var cands = FX.filter(function (f) { return f.date >= from && f.date <= to && f.date >= today && GR[f.g].r === hub && travelHG(hub, f.g) <= maxT; });
      var total = cands.length;
      if (cands.length > 60) {
        cands = cands.map(function (f) { return { f: f, s: buildPlan([f], hub, sets).score }; })
          .sort(function (a, b) { return b.s - a.s; }).slice(0, 60).map(function (x) { return x.f; });
      }
      cands.sort(sortFx);
      var out = [];
      (function rec(startI, chosen) {
        if (chosen.length) out.push(buildPlan(chosen, hub, sets));
        if (chosen.length === maxM) return;
        for (var i = startI; i < cands.length; i++) {
          if (chosen.every(function (c) { return pairOk(c, cands[i]); })) { chosen.push(cands[i]); rec(i + 1, chosen); chosen.pop(); }
        }
      })(0, []);
      out.sort(function (a, b) { return b.score - a.score; });
      var picked = [];
      function overlap(p, q) { return p.keys.filter(function (k) { return q.keys.indexOf(k) >= 0; }).length; }
      out.forEach(function (p) { if (picked.length < 3 && picked.every(function (q) { return overlap(p, q) <= 1; })) picked.push(p); });
      out.forEach(function (p) { if (picked.length < 3 && picked.indexOf(p) < 0) picked.push(p); });
      return { plans: picked, candidates: total };
    }

    /* ---------- state ---------- */
    var KEY = 'weekend-hopper-v2';
    function localISO(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
    var TODAY = localISO(new Date());
    var LAST = FX.length ? FX[FX.length - 1].date : addDays(TODAY, 200);
    function weekend(offset) {
      var d = new Date(TODAY + 'T00:00:00Z'), wd = d.getUTCDay();
      var sat = wd === 0 ? addDays(TODAY, -1) : addDays(TODAY, (6 - wd) % 7);
      sat = addDays(sat, 7 * offset);
      return { from: sat < TODAY ? TODAY : sat, to: addDays(sat, 1) };
    }
    function longDate(iso) { return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); }
    function pinDate(iso) { return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); }
    function route(from, to) { return 'https://www.google.com/maps/dir/?api=1&travelmode=transit&origin=' + encodeURIComponent(from) + '&destination=' + encodeURIComponent(to); }
    function gq(g) { return GR[g].n + ', ' + GR[g].c; }
    function pinOf(f, ex) { var p = { k: f.k, date: f.date, h: f.h, a: f.a, g: f.g, sc: f.sc || '', lg: f.lg }; if (ex) p.ex = true; return p; }
    function examplePins() {
      var out = [];
      ['sansiro', 'oldtrafford', 'arena'].forEach(function (gk) {
        var f = FX.filter(function (x) { return x.g === gk && x.date < TODAY; })[0];
        if (f) out.push(pinOf(f, true));
      });
      return out;
    }

    var wk = weekend(0);
    var state = { city: 'milan', from: wk.from, to: wk.to, maxT: 120, maxM: 3, pins: null };
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s) {
        if (HUBS[s.city]) state.city = s.city;
        if (s.from && s.from >= TODAY && s.to && s.to >= s.from) { state.from = s.from; state.to = s.to; }
        if (s.maxT) state.maxT = Math.min(210, Math.max(30, +s.maxT));
        if ([1, 2, 3].indexOf(s.maxM) >= 0) state.maxM = s.maxM;
        if (Array.isArray(s.pins)) state.pins = s.pins.filter(function (p) { return p && GR[p.g]; });
      }
    } catch (e) { /* storage unavailable */ }
    if (!state.pins) state.pins = examplePins();
    function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } }

    /* ---------- settings ---------- */
    function renderControls() {
      $('cities').innerHTML = Object.keys(HUBS).map(function (k) {
        return '<button type="button" data-city="' + k + '" aria-pressed="' + (state.city === k) + '">' + esc(HUBS[k].name) + '</button>';
      }).join('');
      $('counts').innerHTML = [1, 2, 3].map(function (n) {
        return '<button type="button" data-m="' + n + '" aria-pressed="' + (state.maxM === n) + '">Up to ' + n + '</button>';
      }).join('');
      ['from', 'to'].forEach(function (id) { var el = $(id); el.min = TODAY; el.max = LAST; el.value = state[id]; });
      var w0 = weekend(0), w1 = weekend(1);
      Array.prototype.forEach.call($('quick').children, function (b) {
        var w = b.dataset.q === '0' ? w0 : w1;
        b.setAttribute('aria-pressed', String(state.from === w.from && state.to === w.to));
      });
      var n = daysBetween(state.from, state.to) + 1;
      $('span').textContent = n + (n === 1 ? ' day' : ' days');
      $('maxT').value = state.maxT;
      $('maxTout').textContent = fmtDur(state.maxT);
    }
    function setDates(from, to, changed) {
      var hint = '';
      if (!from || from < TODAY) from = TODAY;
      if (!to || to < from) to = from;
      if (daysBetween(from, to) > 6) {
        if (changed === 'from') to = addDays(from, 6); else from = addDays(to, -6);
        hint = 'Trips can be up to 7 days, so the dates were adjusted.';
      }
      state.from = from; state.to = to;
      $('dateHint').textContent = hint; $('dateHint').hidden = !hint; $('dateHint').className = 'hint alert';
    }

    /* ---------- plans ---------- */
    var lastPlans = [];
    function isPinned(k) { return state.pins.some(function (p) { return p.k === k; }); }
    function matchHTML(it, sets) {
      var m = it.f, gr = GR[m.g];
      var chips = '<span class="chip">' + esc(m.lg) + '</span>';
      if (!sets.g[m.g]) chips += '<span class="chip new">New ground</span>';
      if (!sets.c[gr.cc]) chips += '<span class="chip new">New country: ' + esc(cname(gr.cc)) + '</span>';
      if (m.fl === 2) chips += '<span class="chip warn">Time not set</span>';
      else if (m.fl === 1) chips += '<span class="chip warn">Time may move for TV</span>';
      if (m.hd) chips += '<span class="chip crit">Usually sells out to members</span>';
      if (gr.cc === 'ITA') chips += '<span class="chip">Named ticket, bring ID</span>';
      var ko = m.fl === 2 ? 'TBC<small>about 15:00</small>' : esc(m.t) + (m.fl === 1 ? '<small>provisional</small>' : '');
      var pinned = isPinned(m.k);
      return '<div class="match"><div class="ko">' + ko + '</div><div class="mbody">' +
        '<div class="teams">' + esc(m.h) + ' v ' + esc(m.a) + '</div>' +
        '<div class="where">' + esc(gr.n) + ', ' + esc(gr.c) + '</div>' +
        '<div class="chips">' + chips + '</div>' +
        '<div class="actions"><button class="btn small" type="button" data-pin="' + esc(m.k) + '" aria-pressed="' + pinned + '">' + (pinned ? 'Pinned' : 'Pin to globe') + '</button>' +
        '<a href="https://www.google.com/search?q=' + encodeURIComponent(m.h + ' v ' + m.a + ' tickets official') + '" target="_blank" rel="noopener">Find tickets &#8599;</a></div>' +
        '</div></div>';
    }
    function how(real) { return real ? 'by public transport' : '(estimate)'; }
    function planHTML(p, idx, minTravel, sets) {
      var hub = HUBS[state.city];
      var tags = [];
      if (idx === 0) tags.push('Best fit');
      if (p.travel === minTravel && idx !== 0) tags.push('Least travel');
      var h = '<article class="plan"><div class="plan-head"><span class="plan-name">' + p.ms.length + (p.ms.length === 1 ? ' match' : ' matches') + '</span>' +
        tags.map(function (t) { return '<span class="chip tag">' + t + '</span>'; }).join('') + '</div>';
      h += '<div class="stats">' +
        '<div class="stat"><b>' + p.newG + '</b><span>New grounds</span></div>' +
        '<div class="stat"><b>' + p.newC + '</b><span>New countries</span></div>' +
        '<div class="stat"><b>' + p.newT + '</b><span>New teams</span></div>' +
        '<div class="stat"><b>' + fmtDur(p.travel) + '</b><span>Travelling</span></div></div>';
      p.days.forEach(function (day) {
        h += '<div class="day"><h3>' + longDate(day.date) + '</h3>';
        day.items.forEach(function (it, i) {
          var txt = i === 0
            ? 'Leave ' + esc(it.fromName) + ' by ' + hhmm(it.leaveBy) + ' &middot; ' + fmtDur(it.legMin) + ' ' + how(it.real)
            : fmtDur(it.legMin) + ' from ' + esc(it.fromName) + ' ' + how(it.real) + ' &middot; ' + fmtDur(it.spare) + ' to spare';
          h += '<div class="leg">' + txt + ' &middot; <a href="' + route(it.fromQ, gq(it.f.g)) + '" target="_blank" rel="noopener">Live route &#8599;</a></div>';
          h += matchHTML(it, sets);
        });
        h += '<div class="leg' + (day.trouble ? ' alert' : '') + '">' + fmtDur(day.back) + ' back to ' + esc(hub.station) + ' ' + how(day.backReal) +
          (day.trouble ? ' &middot; ' + esc(day.trouble) : '') +
          ' &middot; <a href="' + route(day.backFromQ, hub.station) + '" target="_blank" rel="noopener">Live route &#8599;</a></div></div>';
      });
      return h + '</article>';
    }
    function renderPlans(recompute) {
      var hub = HUBS[state.city];
      $('plansTitle').textContent = 'Plans from ' + hub.name;
      if (recompute) {
        var res = findPlans(state.city, state.from, state.to, state.maxT, state.maxM, state.pins, TODAY);
        lastPlans = res.plans.map(function (p) { return p.keys; });
        $('candLine').textContent = res.candidates + (res.candidates === 1 ? ' match' : ' matches') + ' within ' + fmtDur(state.maxT) + ' on these dates';
      }
      var wrap = $('plans');
      if (!lastPlans.length) {
        wrap.innerHTML = '<div class="empty">No matches fit these dates within ' + fmtDur(state.maxT) + ' of ' + esc(hub.name) +
          '. Try a longer trip limit or other dates. Leagues also pause for international breaks.</div>';
        return;
      }
      var sets = collected(state.pins, TODAY);
      var plans = lastPlans.map(function (keys) { return buildPlan(keys.map(function (k) { return FX_BY_KEY[k]; }), state.city, sets); });
      var mt = Math.min.apply(null, plans.map(function (p) { return p.travel; }));
      wrap.innerHTML = plans.map(function (p, i) { return planHTML(p, i, mt, sets); }).join('');
    }

    /* ---------- passport ---------- */
    function renderPassport() {
      var sets = collected(state.pins, TODAY);
      var planned = state.pins.filter(function (p) { return p.date > TODAY; }).length;
      $('counters').innerHTML =
        '<div class="counter"><b>' + Object.keys(sets.g).length + '</b><span>Grounds</span></div>' +
        '<div class="counter"><b>' + Object.keys(sets.t).length + '</b><span>Teams</span></div>' +
        '<div class="counter"><b>' + Object.keys(sets.c).length + '</b><span>Countries</span></div>' +
        '<div class="counter"><b>' + planned + '</b><span>Planned</span></div>';
      var byC = {};
      state.pins.forEach(function (p) { if (p.date <= TODAY) { var c = cname(GR[p.g].cc); byC[c] = byC[c] || {}; byC[c][p.g] = 1; } });
      var parts = Object.keys(byC).sort().map(function (c) { return c + ' ' + Object.keys(byC[c]).length; });
      $('countryLine').textContent = parts.length ? 'Grounds by country: ' + parts.join(' · ') : '';
      var sorted = state.pins.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
      $('log').innerHTML = sorted.length ? sorted.map(function (p) {
        var status = p.date > TODAY ? 'planned' : (p.sc ? p.sc : 'been');
        return '<li><div><div class="t">' + esc(p.h) + ' v ' + esc(p.a) + '</div><div class="d">' + esc(GR[p.g].n) + ' &middot; ' + pinDate(p.date) + ' &middot; ' + esc(status) + (p.ex ? ' &middot; example' : '') + '</div></div>' +
          '<button class="link-btn" type="button" data-unpin="' + esc(p.k) + '">Remove</button></li>';
      }).join('') : '<li><div class="empty" style="grid-column:1/-1">No pins yet. Pin a match from a plan, or search for one you went to.</div></li>';
      $('clearExamples').hidden = !state.pins.some(function (p) { return p.ex; });
      Globe.update();
    }
    function renderResults() {
      var q = $('search').value.trim().toLowerCase();
      if (q.length < 2) { $('results').innerHTML = ''; return; }
      var hits = FX.filter(function (f) { return f.date < TODAY && (f.h.toLowerCase().indexOf(q) >= 0 || f.a.toLowerCase().indexOf(q) >= 0); }).reverse().slice(0, 8);
      $('results').innerHTML = hits.length ? hits.map(function (f) {
        var pinned = isPinned(f.k);
        return '<li><div><div class="t" style="font-weight:600">' + esc(f.h) + ' ' + esc(f.sc || 'v') + ' ' + esc(f.a) + '</div><div class="src">' +
          esc(GR[f.g].n) + ' &middot; ' + pinDate(f.date) + ' &middot; ' + esc(f.lg) + '</div></div>' +
          '<button class="btn small" type="button" data-pin="' + esc(f.k) + '" aria-pressed="' + pinned + '">' + (pinned ? 'Pinned' : 'Pin') + '</button></li>';
      }).join('') : '<li><div class="muted">No played matches found for that name this season.</div></li>';
    }
    function togglePin(k) {
      if (isPinned(k)) state.pins = state.pins.filter(function (p) { return p.k !== k; });
      else { var f = FX_BY_KEY[k]; if (f) { state.pins.push(pinOf(f)); Globe.focus(f.g); } }
      save(); renderPlans(false); renderPassport(); renderResults();
    }
    function renderDataNote() {
      var srcs = FIX.sources || {}, groups = {};
      Object.keys(srcs).forEach(function (l) { (groups[srcs[l]] = groups[srcs[l]] || []).push(l); });
      var real = 0, total = 0;
      Object.keys(TH).forEach(function (h) { Object.keys(TH[h]).forEach(function (g) { total++; if (TH[h][g].m) real++; }); });
      var when = FIX.updated ? new Date(FIX.updated).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'unknown';
      $('dataNote').className = '';
      $('dataNote').innerHTML = '<b>Fixtures</b> (updated ' + esc(when) + '): ' + Object.keys(groups).map(function (s) { return esc(groups[s].join(', ')) + ' from ' + esc(s); }).join('; ') +
        '. ' + (real ? real + ' city-to-ground journey times come from Transitous.' : 'Real journey times will appear after the first nightly update.');
    }

    /* ---------- events ---------- */
    document.addEventListener('click', function (ev) {
      var b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.city) { state.city = b.dataset.city; }
      else if (b.dataset.q !== undefined) { var w = weekend(+b.dataset.q); setDates(w.from, w.to); }
      else if (b.dataset.m) { state.maxM = +b.dataset.m; }
      else if (b.dataset.pin) { togglePin(b.dataset.pin); return; }
      else if (b.dataset.unpin) { togglePin(b.dataset.unpin); return; }
      else if (b.id === 'clearExamples') { state.pins = state.pins.filter(function (p) { return !p.ex; }); save(); renderPlans(true); renderPassport(); return; }
      else return;
      save(); renderControls(); renderPlans(true);
    });
    ['from', 'to'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        setDates(id === 'from' ? $('from').value : state.from, id === 'to' ? $('to').value : state.to, id);
        save(); renderControls(); renderPlans(true);
      });
    });
    $('maxT').addEventListener('input', function (ev) { state.maxT = +ev.target.value; $('maxTout').textContent = fmtDur(state.maxT); });
    $('maxT').addEventListener('change', function () { save(); renderPlans(true); });
    $('search').addEventListener('input', renderResults);

    /* ---------- globe ---------- */
    var Globe = (function () {
      var canvas = $('globe'), box = $('globeBox'), ctx = canvas.getContext('2d');
      var ok = typeof d3 !== 'undefined' && typeof topojson !== 'undefined' && WORLD;
      var proj, path, countries, borders, grat, size = 0, rot = [-8, -50, 0], zoom = 3, anim = null, focusG = null;
      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!ok) { $('globeFallback').hidden = false; canvas.hidden = true; return { update: function () {}, focus: function () {} }; }
      countries = topojson.feature(WORLD, WORLD.objects.countries).features.concat(WORLD_EXTRA ? WORLD_EXTRA.features : [])
        .filter(function (f) { return f.geometry && d3.geoArea(f) < 2 * Math.PI; });
      borders = topojson.mesh(WORLD, WORLD.objects.countries, function (a, b) { return a !== b; });
      grat = d3.geoGraticule10();
      proj = d3.geoOrthographic().clipAngle(90).precision(0.4);
      path = d3.geoPath(proj, ctx);

      function col(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
      function resize() {
        var w = box.clientWidth, dpr = window.devicePixelRatio || 1;
        size = w; canvas.width = w * dpr; canvas.height = w * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        draw();
      }
      function pinGroups() {
        var gs = {};
        state.pins.forEach(function (p) {
          if (!GR[p.g]) return;
          var g = gs[p.g] = gs[p.g] || { g: p.g, been: false, plan: false };
          if (p.date <= TODAY) g.been = true; else g.plan = true;
        });
        return Object.keys(gs).map(function (k) { return gs[k]; });
      }
      function visible(lon, lat) { return d3.geoDistance([lon, lat], [-rot[0], -rot[1]]) < Math.PI / 2 - 0.02; }
      function draw() {
        if (!size) return;
        proj.scale((size / 2 - 3) * zoom).translate([size / 2, size / 2]).rotate(rot);
        ctx.clearRect(0, 0, size, size);
        ctx.save();
        ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 1, 0, 2 * Math.PI); ctx.clip();
        ctx.beginPath(); path({ type: 'Sphere' }); ctx.fillStyle = col('--sea'); ctx.fill();
        ctx.beginPath(); path(grat); ctx.strokeStyle = col('--grat'); ctx.lineWidth = 0.6; ctx.stroke();
        var hit = {};
        state.pins.forEach(function (p) { if (p.date <= TODAY && GR[p.g]) hit[MAPNAME[GR[p.g].cc]] = 1; });
        var land = col('--land'), landHit = col('--land-hit');
        countries.forEach(function (f) { ctx.beginPath(); path(f); ctx.fillStyle = hit[f.properties.name] ? landHit : land; ctx.fill(); });
        ctx.beginPath(); path(borders); ctx.strokeStyle = col('--border'); ctx.lineWidth = 0.7; ctx.stroke();
        var hub = HUBS[state.city], ink = col('--ink'), lamp = col('--lamp'), pitch = col('--pitch');
        if (visible(hub.lon, hub.lat)) {
          var hp = proj([hub.lon, hub.lat]);
          ctx.fillStyle = ink; ctx.fillRect(hp[0] - 3.5, hp[1] - 3.5, 7, 7);
          if (zoom >= 4) { ctx.font = '600 12px Barlow, system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.fillText(hub.name, hp[0] - 8, hp[1] + 4); ctx.textAlign = 'left'; }
        }
        pinGroups().forEach(function (gp) {
          var g = GR[gp.g]; if (!visible(g.lon, g.lat)) return;
          var p = proj([g.lon, g.lat]);
          ctx.beginPath(); ctx.arc(p[0], p[1], 6, 0, 2 * Math.PI);
          if (gp.been) { ctx.fillStyle = lamp; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = ink; ctx.stroke(); }
          else { ctx.lineWidth = 2.5; ctx.strokeStyle = pitch; ctx.stroke(); }
          if (gp.g === focusG) { ctx.beginPath(); ctx.arc(p[0], p[1], 11, 0, 2 * Math.PI); ctx.lineWidth = 1.5; ctx.strokeStyle = ink; ctx.stroke(); }
          if (zoom >= 7) { ctx.fillStyle = ink; ctx.font = '600 12px Barlow, system-ui, sans-serif'; ctx.fillText(g.n, p[0] + 10, p[1] + 4); }
        });
        ctx.restore();
        ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 1, 0, 2 * Math.PI); ctx.strokeStyle = col('--line'); ctx.lineWidth = 1.5; ctx.stroke();
      }
      function animateTo(r2, z2) {
        if (anim) cancelAnimationFrame(anim);
        r2 = r2.slice();
        while (r2[0] - rot[0] > 180) r2[0] -= 360;
        while (r2[0] - rot[0] < -180) r2[0] += 360;
        if (reduce) { rot = r2; zoom = z2; draw(); return; }
        var z1 = zoom, t0 = performance.now(), ir = d3.interpolate(rot.slice(), r2);
        (function step(t) {
          var k = Math.min(1, (t - t0) / 700), e = d3.easeCubicInOut(k);
          rot = ir(e); zoom = z1 + (z2 - z1) * e; draw();
          if (k < 1) anim = requestAnimationFrame(step);
        })(t0);
      }
      function fitView() {
        var gs = pinGroups();
        if (!gs.length) return { r: [-8, -50, 0], z: 3 };
        var pts = gs.map(function (gp) { return [GR[gp.g].lon, GR[gp.g].lat]; });
        var c = d3.geoCentroid({ type: 'MultiPoint', coordinates: pts });
        var maxD = Math.max.apply(null, pts.map(function (p) { return d3.geoDistance(p, c); }));
        return { r: [-c[0], -c[1], 0], z: Math.max(1, Math.min(14, 0.8 / Math.max(Math.sin(maxD), 0.05))) };
      }
      function showInfo(gk) {
        focusG = gk;
        var el = $('pinInfo');
        if (!gk) { el.hidden = true; draw(); return; }
        var g = GR[gk], ps = state.pins.filter(function (p) { return p.g === gk; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
        el.innerHTML = '<b>' + esc(g.n) + '</b> <span class="muted">' + esc(g.c) + ', ' + esc(cname(g.cc)) + '</span><ul class="log" style="margin-top:8px">' +
          ps.map(function (p) { return '<li><div><div class="t">' + esc(p.h) + ' v ' + esc(p.a) + '</div><div class="d">' + pinDate(p.date) + ' &middot; ' + (p.date > TODAY ? 'planned' : esc(p.sc || 'been')) + '</div></div><span></span></li>'; }).join('') + '</ul>';
        el.hidden = false; draw();
      }
      var drag = null;
      canvas.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, r: rot.slice(), moved: false }; canvas.setPointerCapture(e.pointerId); if (anim) cancelAnimationFrame(anim); });
      canvas.addEventListener('pointermove', function (e) {
        if (!drag) return;
        var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        var k = 0.35 / zoom;
        rot = [drag.r[0] + dx * k, Math.max(-85, Math.min(85, drag.r[1] - dy * k)), 0];
        draw();
      });
      function end(e) {
        if (!drag) return;
        if (!drag.moved && e.type === 'pointerup') {
          var r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, best = null, bd = 14;
          pinGroups().forEach(function (gp) {
            var g = GR[gp.g]; if (!visible(g.lon, g.lat)) return;
            var p = proj([g.lon, g.lat]), d = Math.hypot(p[0] - x, p[1] - y);
            if (d < bd) { bd = d; best = gp.g; }
          });
          showInfo(best);
        }
        drag = null;
      }
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', end);
      canvas.addEventListener('dblclick', function () { animateTo(rot.slice(), Math.min(16, zoom * 1.6)); });
      $('zoomIn').addEventListener('click', function () { animateTo(rot.slice(), Math.min(16, zoom * 1.6)); });
      $('zoomOut').addEventListener('click', function () { animateTo(rot.slice(), Math.max(1, zoom / 1.6)); });
      $('fitPins').addEventListener('click', function () { var v = fitView(); animateTo(v.r, v.z); });
      if (window.ResizeObserver) new ResizeObserver(resize).observe(box); else window.addEventListener('resize', resize);
      if (window.matchMedia) { var mq = window.matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', draw); }
      var v0 = fitView(); rot = v0.r; zoom = v0.z;
      resize();
      return {
        update: function () { if (focusG && !state.pins.some(function (p) { return p.g === focusG; })) showInfo(null); else if (focusG) showInfo(focusG); else draw(); },
        focus: function (gk) { var g = GR[gk]; focusG = gk; animateTo([-g.lon, -g.lat, 0], Math.max(zoom, 6)); }
      };
    })();

    renderControls(); renderPlans(true); renderPassport(); renderDataNote();
    window.WeekendHopper = { findPlans: findPlans, travelHG: travelHG, travelGG: travelGG, FX: FX, GR: GR };
  }
})();

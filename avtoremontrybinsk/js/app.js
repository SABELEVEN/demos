(function () {
  "use strict";
  var S = window.STUDIO;
  var app = document.getElementById("app");
  var STORE_KEY = "ar_bookings_v1";
  var DAY_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

  /* ---------- утилиты ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function parseHM(hm) { var p = hm.split(":"); return +p[0] * 60 + +p[1]; }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function toInputDate(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function fromInputDate(v) { var p = v.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function fmtLong(d) { return d.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" }); }
  function fmtTime(d) { return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function fmtRub(n) { return n.toLocaleString("ru-RU") + " ₽"; }
  function fmtDuration(min) {
    var h = Math.floor(min / 60), m = min % 60, out = [];
    if (h) out.push(h + " ч");
    if (m) out.push(m + " мин");
    return out.join(" ");
  }
  function priceHtml(s) {
    if (s.price === 0) return '<span class="svc-price is-free">Бесплатно</span>';
    if (s.price == null) return '<span class="svc-price">Цена по запросу</span>';
    return '<span class="svc-price">от ' + fmtRub(s.price) + "</span>";
  }
  function priceText(s) {
    if (s.price === 0) return "Бесплатно";
    if (s.price == null) return "Цена по запросу";
    return "от " + fmtRub(s.price);
  }
  function serviceById(id) {
    for (var i = 0; i < S.services.length; i++) if (S.services[i].id === id) return S.services[i];
    return null;
  }
  function plural(n, f) { var a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return f[2]; if (b > 1 && b < 5) return f[1]; if (b === 1) return f[0]; return f[2]; }

  var toastTimer;
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("is-on"); }, 3200);
  }

  /* ---------- хранилище записей (на этом устройстве) ---------- */
  // Если браузер не даёт пользоваться хранилищем (приватный режим, встроенный просмотр), записи живут в памяти до закрытия страницы
  var memoryStore = "[]";
  function loadBookings() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); }
    catch (e) { try { return JSON.parse(memoryStore); } catch (e2) { return []; } }
  }
  function saveBookings(list) {
    var json = JSON.stringify(list);
    memoryStore = json;
    try { localStorage.setItem(STORE_KEY, json); } catch (e) { /* хранилище недоступно */ }
  }

  /* ---------- занятость с сервера (общая для всех клиентов) ---------- */
  var remote = { busy: null, boxes: null };
  function fetchBusy() {
    if (!S.slotsEndpoint || typeof fetch === "undefined") return Promise.resolve(false);
    return fetch(S.slotsEndpoint, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !Array.isArray(j.busy)) return false;
        remote.busy = j.busy.map(function (x) { var s = new Date(x.s).getTime(); return { bs: s, be: s + x.d * 60000 }; });
        remote.boxes = j.boxes > 0 ? j.boxes : null;
        return true;
      })
      .catch(function () { return false; });
  }

  /* ---------- статусы моих записей с сервера (отмена владельцем) ---------- */
  function syncMine() {
    if (!S.mineEndpoint || typeof fetch === "undefined") return;
    var ids = loadBookings().filter(function (b) { return /^[0-9a-f-]{36}$/i.test(b.id) && b.status !== "cancelled"; }).map(function (b) { return b.id; });
    if (!ids.length) return;
    fetch(S.mineEndpoint + "?ids=" + ids.join(","), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !Array.isArray(j.items)) return;
        var cur = loadBookings(), changed = false;
        j.items.forEach(function (it) {
          if (it.status !== "cancelled") return;
          cur.forEach(function (b) { if (b.id === it.id && b.status !== "cancelled") { b.status = "cancelled"; changed = true; } });
        });
        if (changed) { saveBookings(cur); if ((location.hash || "#/") === "#/bookings") render(); }
      })
      .catch(function () {});
  }

  /* ---------- слоты ---------- */
  function slotsFor(day, service) {
    var hours = S.hours[day.getDay()];
    if (!hours) return [];
    var open = parseHM(hours[0]), close = parseHM(hours[1]);
    var now = new Date();
    var earliest = now.getTime() + S.leadMinutes * 60000;
    // если сервер ответил, берём занятость оттуда; иначе только записи этого устройства
    var booked = remote.busy || loadBookings().filter(function (b) { return b.status !== "cancelled"; }).map(function (b) {
      var s = new Date(b.start).getTime(); return { bs: s, be: s + b.duration * 60000 };
    });
    var cap = remote.boxes || S.boxes;
    var out = [];
    for (var t = open; t + service.duration <= close; t += S.slotStepMinutes) {
      var start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(t / 60), t % 60);
      if (start.getTime() < earliest) continue;
      var end = start.getTime() + service.duration * 60000;
      var busy = 0;
      for (var i = 0; i < booked.length; i++) {
        if (booked[i].bs < end && booked[i].be > start.getTime()) busy++;
      }
      if (busy < cap) out.push(start);
    }
    return out;
  }

  /* ---------- телефон ---------- */
  function normPhone(v) {
    var d = String(v).replace(/\D/g, "");
    if (d.length === 11 && (d[0] === "7" || d[0] === "8")) d = "7" + d.slice(1);
    else if (d.length === 10) d = "7" + d;
    else return null;
    return d;
  }
  function fmtPhone(d) {
    return "+7 (" + d.slice(1, 4) + ") " + d.slice(4, 7) + "-" + d.slice(7, 9) + "-" + d.slice(9, 11);
  }

  /* ---------- шапка ---------- */
  document.getElementById("phoneBtn").href = "tel:" + S.contacts.phoneRaw;
  document.getElementById("phoneText").textContent = S.contacts.phone;

  /* ---------- представления ---------- */
  function servicesList(detailed) {
    return '<ul class="svc-list">' + S.services.map(function (s) {
      return '<li class="svc">' +
        "<div><h3 class=\"svc-name\">" + esc(s.name) + "</h3>" +
        '<p class="svc-text">' + esc(s.text) + "</p></div>" +
        '<div class="svc-meta">' + priceHtml(s) + (detailed ? '<small class="svc-price"><small>' + esc(fmtDuration(s.duration)) + "</small></small>" : "") +
        '<button class="btn btn--small" type="button" data-book="' + esc(s.id) + '">Записаться</button></div>' +
        "</li>";
    }).join("") + "</ul>";
  }

  function contactBlock() {
    var c = S.contacts;
    return '<div class="contact">' +
      "<dl>" +
      "<div><dt>Адрес</dt><dd>" + esc(c.address) + "</dd></div>" +
      '<div><dt>Телефон</dt><dd><a href="tel:' + esc(c.phoneRaw) + '">' + esc(c.phone) + "</a></dd></div>" +
      "<div><dt>Часы работы</dt><dd>" + S.hoursText.map(function (h) {
        return '<div class="hours-row"><span>' + esc(h.days) + "</span><span>" + esc(h.time) + "</span></div>";
      }).join("") + "</dd></div>" +
      "</dl>" +
      '<div class="contact-actions">' +
      '<a class="btn" href="tel:' + esc(c.phoneRaw) + '">Позвонить</a>' +
      '<a class="btn btn--ghost" href="' + esc(c.mapUrl) + '" target="_blank" rel="noopener">Построить маршрут</a>' +
      (c.vk ? '<a class="btn btn--ghost" href="' + esc(c.vk) + '" target="_blank" rel="noopener">Мы во ВКонтакте</a>' : "") +
      "</div></div>";
  }

  function viewHome() {
    return '<div class="wrap">' +
      '<section class="hero" aria-labelledby="heroTitle">' +
      '<h1 class="sr-only" id="heroTitle">' + esc(S.name) + ". " + esc(S.heroTitleLine1) + " " + esc(S.heroTitleLine2) + "</h1>" +
      '<div class="photo" id="photo">' +
      '<div class="photo__bg" id="photoBg"></div>' +
      '<div class="photo__empty"><img src="assets/logo.png" alt=""></div>' +
      '<img class="photo__img" id="photoImg" src="' + esc(S.heroPhoto) + '" alt="' + esc(S.heroPhotoAlt) + '" width="1200" height="1600" decoding="async">' +
      (S.heroPhotoLit ? '<img class="photo__img photo__img--lit" id="photoLit" src="' + esc(S.heroPhotoLit) + '" alt="" aria-hidden="true" width="1200" height="1600" decoding="async">' : "") +
      "</div>" +
      "</section>" +

      '<section class="section" aria-labelledby="svcTitle"><div class="section-head"><h2 class="h2" id="svcTitle">Выберите услугу</h2>' +
      '<p class="lead">Нажмите «Записаться», выберите день и время. Мы подтвердим запись по телефону.</p></div>' +
      servicesList(false) + "</section>" +

      ((S.offers && S.offers.length) ? ('<section class="section" aria-labelledby="offTitle"><div class="section-head"><h2 class="h2" id="offTitle">Новым клиентам</h2></div>' +
      '<ul class="offers">' + S.offers.map(function (o) { return "<li>" + esc(o) + "</li>"; }).join("") + "</ul></section>") : "") +

      '<section class="section" aria-labelledby="conTitle"><div class="section-head"><h2 class="h2" id="conTitle">Как нас найти</h2>' +
      '<p class="lead">' + esc(S.district) + ", " + esc(S.city) + "</p></div>" + contactBlock() + "</section>" +

      '<footer class="footer">© ' + new Date().getFullYear() + " " + esc(S.name) + "</footer>" +
      "</div>";
  }

  function viewServices() {
    return '<div class="wrap"><div class="page-title section-head"><h1 class="h2">Услуги</h1>' +
      '<p class="lead">Длительность указана ориентировочно. Точную стоимость назовёт мастер после осмотра автомобиля.</p></div>' +
      servicesList(true) + "</div>";
  }

  function bookingCard(b, past) {
    var d = new Date(b.start);
    var cancelled = b.status === "cancelled";
    var state = cancelled ? "Отменена" : b.status === "local" ? "Сохранена на этом устройстве" : "Заявка отправлена в автосервис";
    return '<li class="book"><h3>' + esc(b.serviceName) + "</h3>" +
      '<div class="book-when">' + esc(fmtLong(d)) + ", " + esc(fmtTime(d)) + "</div>" +
      '<div class="book-car">' + esc(b.car) + (b.plate ? ", " + esc(b.plate) : "") + "</div>" +
      '<div class="book-state">' + esc(state) + "</div>" +
      (!past && !cancelled ? '<div class="book-actions"><button class="btn btn--ghost btn--small" type="button" data-cancel="' + esc(b.id) + '">Отменить запись</button>' +
        '<a class="btn btn--ghost btn--small" href="tel:' + esc(S.contacts.phoneRaw) + '">Позвонить</a></div>' : "") +
      "</li>";
  }

  function viewBookings() {
    var list = loadBookings().sort(function (a, b) { return new Date(a.start) - new Date(b.start); });
    var now = Date.now();
    var upcoming = list.filter(function (b) { return new Date(b.start).getTime() >= now; });
    var past = list.filter(function (b) { return new Date(b.start).getTime() < now; }).reverse();
    var html = '<div class="wrap"><div class="page-title section-head"><h1 class="h2">Мои записи</h1>' +
      '<p class="lead">Здесь видны записи, сделанные с этого устройства.</p></div>';
    if (!list.length) {
      html += '<div class="empty"><p>Записей пока нет. Выберите услугу, и запись появится здесь.</p>' +
        '<button class="btn" type="button" data-book="">Записаться</button></div>';
    } else {
      if (upcoming.length) html += '<h2 class="group-title">Предстоящие</h2><ul class="book-list">' + upcoming.map(function (b) { return bookingCard(b, false); }).join("") + "</ul>";
      if (past.length) html += '<h2 class="group-title">Прошедшие</h2><ul class="book-list">' + past.map(function (b) { return bookingCard(b, true); }).join("") + "</ul>";
    }
    return html + "</div>";
  }

  var deferredInstall = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); deferredInstall = e;
    var btn = document.getElementById("installBtn");
    if (btn) btn.hidden = false;
  });

  function viewInstall() {
    return '<div class="wrap"><div class="page-title section-head"><h1 class="h2">Добавьте автосервис на главный экран</h1>' +
      '<p class="lead">Своя иконка на телефоне: запись и ваши заказы открываются в одно касание, как обычное приложение.</p></div>' +
      '<p><button class="btn" type="button" id="installBtn" hidden>Установить приложение</button></p>' +
      '<div class="install-grid">' +
      "<section><h3>iPhone и iPad (Safari)</h3><ol class=\"steps\">" +
      "<li>Откройте сайт в Safari.</li>" +
      "<li>Нажмите «Поделиться» (квадрат со стрелкой) внизу экрана.</li>" +
      "<li>Выберите «На экран «Домой»».</li>" +
      "<li>Оставьте включённым «Открыть как веб-приложение» и нажмите «Добавить».</li></ol></section>" +
      "<section><h3>Android (Chrome)</h3><ol class=\"steps\">" +
      "<li>Откройте сайт в Chrome.</li>" +
      "<li>Нажмите меню с тремя точками справа вверху.</li>" +
      "<li>Выберите «Установить приложение» или «Добавить на главный экран».</li>" +
      "<li>Подтвердите установку.</li></ol></section></div></div>";
  }

  var routes = { "/": viewHome, "/services": viewServices, "/bookings": viewBookings, "/install": viewInstall };
  var navKey = { "/": "home", "/services": "services", "/bookings": "bookings", "/install": "install" };

  function setupPhoto() {
    var frame = document.getElementById("photo");
    var img = document.getElementById("photoImg");
    if (!frame || !img) return;
    function onLoad() {
      var r = img.naturalWidth / img.naturalHeight;
      if (Math.abs(r - 1774 / 887) / (1774 / 887) > 0.04) {
        frame.classList.add("is-fit");
        document.getElementById("photoBg").style.backgroundImage = "url('" + img.currentSrc.replace(/'/g, "%27") + "')";
      }
    }
    img.addEventListener("error", function () { frame.classList.add("no-photo"); });
    var lit = document.getElementById("photoLit");
    if (lit) lit.addEventListener("error", function () { lit.remove(); });
    if (img.complete) { img.naturalWidth ? onLoad() : frame.classList.add("no-photo"); }
    else img.addEventListener("load", onLoad);
  }

  function render() {
    var path = (location.hash || "#/").slice(1) || "/";
    if (!routes[path]) path = "/";
    app.innerHTML = routes[path]();
    var key = navKey[path];
    document.querySelectorAll("[data-nav]").forEach(function (a) {
      var on = a.getAttribute("data-nav") === key;
      a.classList.toggle("is-active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    document.title = (path === "/" ? "" : { "/services": "Услуги", "/bookings": "Мои записи", "/install": "Установка" }[path] + " — ") + "Авторемонт, автосервис в Рыбинске";
    if (path === "/") setupPhoto();
    if (path === "/bookings") syncMine();
    if (path === "/install" && deferredInstall) document.getElementById("installBtn").hidden = false;
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", render);
  fetchBusy();
  syncMine();
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { syncMine(); fetchBusy(); } });
  setInterval(function () { if (!document.hidden) syncMine(); }, 30000);

  /* ---------- боковое меню (шторка слева) ---------- */
  var drawerRoot = document.getElementById("drawerRoot");
  var drawerEl = document.getElementById("drawer");
  var menuBtn = document.getElementById("menuBtn");
  function drawerOpen() { return drawerRoot && !drawerRoot.hidden; }
  function openDrawer() {
    if (!drawerRoot || drawerOpen()) return;
    drawerRoot.hidden = false;
    menuBtn.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";
    var first = drawerEl.querySelector("a,button");
    if (first) first.focus();
  }
  function closeDrawer(back) {
    if (!drawerOpen()) return;
    drawerRoot.hidden = true;
    menuBtn.setAttribute("aria-expanded", "false");
    document.body.style.overflow = "";
    if (back !== false) menuBtn.focus();
  }
  if (menuBtn && drawerRoot) {
    menuBtn.addEventListener("click", function () { drawerOpen() ? closeDrawer() : openDrawer(); });
    drawerRoot.addEventListener("click", function (ev) {
      if (ev.target.closest("[data-drawer-close]") || ev.target.closest("a")) closeDrawer(false);
    });
    document.addEventListener("keydown", function (ev) {
      if (!drawerOpen()) return;
      if (ev.key === "Escape") { closeDrawer(); return; }
      if (ev.key === "Tab") {
        var f = drawerEl.querySelectorAll("a,button");
        if (!f.length) return;
        var a = f[0], z = f[f.length - 1];
        if (ev.shiftKey && document.activeElement === a) { ev.preventDefault(); z.focus(); }
        else if (!ev.shiftKey && document.activeElement === z) { ev.preventDefault(); a.focus(); }
      }
    });
    window.matchMedia("(max-width:719px)").addEventListener("change", function (e) { if (e.matches) closeDrawer(false); });
  }

  /* ---------- шторка записи ---------- */
  var root = document.getElementById("sheetRoot");
  var sheet = document.getElementById("sheet");
  var st = null;
  var lastFocus = null;

  function openBooking(serviceId) {
    var svc = serviceId ? serviceById(serviceId) : null;
    st = { step: svc ? 2 : 1, service: svc, day: null, time: null, name: "", phone: "", car: "", plate: "", errors: {}, busy: false, result: null };
    lastFocus = document.activeElement;
    root.hidden = false;
    document.body.style.overflow = "hidden";
    drawSheet();
    fetchBusy().then(function (ok) { if (ok && st && !st.result && st.step === 2 && !st.busy) drawSheet(); });
  }
  function closeBooking() {
    root.hidden = true;
    document.body.style.overflow = "";
    st = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function progress(step) {
    var out = '<div class="progress" aria-hidden="true">';
    for (var i = 1; i <= 4; i++) out += '<i class="' + (i <= step ? "is-done" : "") + '"></i>';
    return out + "</div>";
  }
  var TITLES = { 1: "Выберите услугу", 2: "Дата и время", 3: "Ваши данные", 4: "Проверьте запись" };

  function head(step) {
    return '<div class="sheet-head"><div><h2 id="sheetTitle">' + TITLES[step] + '</h2><p class="sheet-step">Шаг ' + step + " из 4</p></div>" +
      '<button class="icon-btn" type="button" data-close aria-label="Закрыть"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/></svg></button></div>' +
      progress(step);
  }
  function chosenLine() {
    return '<p class="chosen"><span>' + esc(st.service.name) + "</span><span>" + esc(priceText(st.service)) + "</span></p>";
  }

  function drawSheet() {
    var h = "";
    if (st.result) { h = drawDone(); }
    else if (st.step === 1) {
      h = head(1) + '<ul class="pick-list">' + S.services.map(function (s) {
        return '<li><button class="pick" type="button" data-pick="' + esc(s.id) + '" aria-pressed="' + (st.service && st.service.id === s.id) + '">' +
          "<span><b>" + esc(s.name) + "</b><small>" + esc(fmtDuration(s.duration)) + "</small></span><span>" + esc(priceText(s)) + "</span></button></li>";
      }).join("") + "</ul>";
    } else if (st.step === 2) {
      var today = startOfDay(new Date());
      var days = "";
      for (var i = 0; i < 7; i++) {
        var d = addDays(today, i);
        var has = slotsFor(d, st.service).length > 0;
        var sel = st.day && sameDay(st.day, d);
        days += '<button class="day" type="button" data-day="' + toInputDate(d) + '" aria-pressed="' + !!sel + '"' + (has ? "" : " disabled") + ">" +
          "<small>" + DAY_SHORT[d.getDay()] + "</small><b>" + d.getDate() + "</b></button>";
      }
      var slotsHtml = "";
      if (st.day) {
        var sl = slotsFor(st.day, st.service);
        slotsHtml = '<span class="field-label">Свободное время, ' + esc(fmtLong(st.day)) + '</span><div class="slots">' +
          (sl.length ? sl.map(function (t) {
            var key = fmtTime(t);
            return '<button class="slot" type="button" data-time="' + key + '" aria-pressed="' + (st.time === key) + '">' + key + "</button>";
          }).join("") : '<div class="slot-empty">На этот день свободного времени нет. Выберите другой день.</div>') + "</div>";
      }
      h = head(2) + chosenLine() + '<div class="days" role="group" aria-label="Ближайшие дни">' + days + "</div>" +
        '<label class="field-label" for="otherDate">Другая дата</label>' +
        '<input type="date" id="otherDate" min="' + toInputDate(today) + '" max="' + toInputDate(addDays(today, S.maxDaysAhead)) + '"' + (st.day ? ' value="' + toInputDate(st.day) + '"' : "") + ">" +
        slotsHtml +
        '<div class="sheet-actions"><button class="btn" type="button" data-next ' + (st.day && st.time ? "" : "disabled") + ">Далее</button>" +
        (!serviceFixed() ? '<button class="btn btn--ghost" type="button" data-back>Назад</button>' : '<button class="btn btn--ghost" type="button" data-back>Выбрать другую услугу</button>') + "</div>";
    } else if (st.step === 3) {
      var e = st.errors;
      h = head(3) + chosenLine() +
        '<label class="field-label" for="fName">Имя</label><input type="text" id="fName" autocomplete="name" value="' + esc(st.name) + '" placeholder="Как к вам обращаться"' + (e.name ? ' aria-invalid="true"' : "") + ">" + (e.name ? '<p class="err">' + e.name + "</p>" : "") +
        '<label class="field-label" for="fPhone">Телефон</label><input type="tel" id="fPhone" autocomplete="tel" inputmode="tel" value="' + esc(st.phone) + '" placeholder="+7 (___) ___-__-__"' + (e.phone ? ' aria-invalid="true"' : "") + ">" + (e.phone ? '<p class="err">' + e.phone + "</p>" : "") +
        '<label class="field-label" for="fCar">Автомобиль</label><input type="text" id="fCar" autocomplete="off" value="' + esc(st.car) + '" placeholder="Марка и модель, например Lada Vesta"' + (e.car ? ' aria-invalid="true"' : "") + ">" + (e.car ? '<p class="err">' + e.car + "</p>" : "") +
        '<label class="field-label" for="fPlate">Госномер (по желанию)</label><input type="text" id="fPlate" autocomplete="off" value="' + esc(st.plate) + '" placeholder="А123ВС174">' +
        '<input class="hp" type="text" id="fHp" tabindex="-1" autocomplete="off" aria-hidden="true">' +
        '<div class="sheet-actions"><button class="btn" type="button" data-check>Проверить запись</button><button class="btn btn--ghost" type="button" data-back>Назад</button></div>';
    } else if (st.step === 4) {
      var start = slotStart();
      h = head(4) + '<dl class="summary">' +
        "<div><dt>Услуга</dt><dd>" + esc(st.service.name) + "</dd></div>" +
        "<div><dt>Стоимость</dt><dd>" + esc(priceText(st.service)) + "</dd></div>" +
        "<div><dt>Когда</dt><dd>" + esc(fmtLong(start)) + ", " + esc(fmtTime(start)) + "</dd></div>" +
        "<div><dt>Имя</dt><dd>" + esc(st.name) + "</dd></div>" +
        "<div><dt>Телефон</dt><dd>" + esc(fmtPhone(st.phone)) + "</dd></div>" +
        "<div><dt>Автомобиль</dt><dd>" + esc(st.car) + (st.plate ? ", " + esc(st.plate) : "") + "</dd></div>" +
        "<div><dt>Адрес</dt><dd>" + esc(S.contacts.addressShort) + "</dd></div></dl>" +
        '<p class="sheet-note">Точную стоимость назовёт мастер после осмотра. Время можно изменить по телефону.</p>' +
        '<div class="sheet-actions"><button class="btn" type="button" data-confirm ' + (st.busy ? "disabled" : "") + ">" + (st.busy ? "Отправляем…" : "Подтвердить запись") + '</button><button class="btn btn--ghost" type="button" data-back ' + (st.busy ? "disabled" : "") + ">Назад</button></div>";
    }
    sheet.innerHTML = h;
    var focusEl = sheet.querySelector("[autofocus], .pick[aria-pressed=true], .day[aria-pressed=true], input:not(.hp), .btn, .icon-btn");
    if (st && st.keepFocus) { var kf = sheet.querySelector(st.keepFocus); if (kf) kf.focus(); st.keepFocus = null; }
    else if (focusEl) focusEl.focus({ preventScroll: true });
  }
  function serviceFixed() { return st.fromService; }
  function slotStart() {
    var p = st.time.split(":");
    return new Date(st.day.getFullYear(), st.day.getMonth(), st.day.getDate(), +p[0], +p[1]);
  }

  function drawDone() {
    var r = st.result, start = new Date(r.booking.start);
    return '<div class="done"><div class="tick"><svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="m5 12.5 4.5 4.5L19 7.5"/></svg></div>' +
      '<h2 id="sheetTitle">' + (r.mode === "local" ? "Заявка сохранена" : "Запись создана") + '</h2><p class="lead" style="margin:0 auto">' +
      (r.mode === "local" ? "Выбранное время: " : "Ждём вас: ") + esc(fmtLong(start)) + ", " + esc(fmtTime(start)) + ".</p>" +
      '<dl class="summary"><div><dt>Услуга</dt><dd>' + esc(r.booking.serviceName) + "</dd></div>" +
      "<div><dt>Автомобиль</dt><dd>" + esc(r.booking.car) + "</dd></div>" +
      "<div><dt>Адрес</dt><dd>" + esc(S.contacts.addressShort) + "</dd></div></dl>" +
      (r.mode === "local" ? '<div class="warn">Заявка сохранена на этом устройстве, но автосервис её пока не получил. Позвоните, чтобы подтвердить запись: ' + esc(S.contacts.phone) + ".</div>" : "") +
      '<div class="sheet-actions"><a class="btn" href="#/bookings" data-close>Мои записи</a>' +
      (r.mode === "local" ? '<a class="btn btn--ghost" href="tel:' + esc(S.contacts.phoneRaw) + '">Позвонить</a>' : '<button class="btn btn--ghost" type="button" data-close>Закрыть</button>') + "</div></div>";
  }

  function validateContacts() {
    var e = {};
    var name = st.name.trim(), car = st.car.trim();
    if (name.length < 2) e.name = "Введите имя, минимум 2 буквы.";
    var ph = normPhone(st.phone);
    if (!ph) e.phone = "Введите номер в формате +7 (900) 000-00-00.";
    if (car.length < 2) e.car = "Укажите марку и модель автомобиля.";
    st.errors = e;
    if (ph) st.phone = ph;
    return !Object.keys(e).length;
  }

  function post(payload) {
    return new Promise(function (resolve) {
      var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 10000);
      fetch(S.apiEndpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: ctl ? ctl.signal : undefined,
      }).then(function (r) {
        clearTimeout(timer);
        r.json().catch(function () { return {}; }).then(function (data) { resolve({ ok: r.ok, status: r.status, data: data || {} }); });
      }).catch(function () { clearTimeout(timer); resolve({ ok: false, status: 0, data: {} }); });
    });
  }

  function confirmBooking() {
    if (st.busy) return;
    var start = slotStart();
    // повторная проверка занятости непосредственно перед отправкой
    var still = slotsFor(st.day, st.service).some(function (t) { return fmtTime(t) === st.time; });
    if (!still) {
      st.step = 2; st.time = null;
      drawSheet();
      toast("Это время уже занято. Выберите другое.");
      return;
    }
    st.busy = true; drawSheet();
    var booking = {
      id: "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      serviceId: st.service.id, serviceName: st.service.name, price: st.service.price,
      start: start.toISOString(), duration: st.service.duration,
      name: st.name.trim(), phone: st.phone, car: st.car.trim(), plate: st.plate.trim(), status: "sent",
      createdAt: new Date().toISOString(),
    };
    var hp = sheet.querySelector("#fHp");
    post({
      type: "create", id: booking.id, serviceName: booking.serviceName, priceText: priceText(st.service),
      whenText: fmtLong(start) + ", " + fmtTime(start), start: booking.start, durationMin: booking.duration,
      name: booking.name, phone: booking.phone, car: booking.car, plate: booking.plate, website: st.hp || (hp ? hp.value : ""),
    }).then(function (res) {
      if (res.status === 409) {
        // время успели занять: обновляем занятость и возвращаем клиента к выбору времени
        fetchBusy().then(function () {
          st.busy = false; st.step = 2; st.time = null; drawSheet();
          toast("Это время только что заняли. Выберите другое.");
        });
        return;
      }
      var ok = res.ok;
      if (ok && res.data && res.data.id) booking.id = res.data.id;
      booking.status = ok ? "sent" : "local";
      var list = loadBookings(); list.push(booking); saveBookings(list);
      if (ok) fetchBusy();
      st.busy = false;
      st.result = { mode: ok ? "sent" : "local", booking: booking };
      drawSheet();
    });
  }

  /* ---------- события ---------- */
  document.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-book],[data-close],[data-cancel],[data-pick],[data-day],[data-time],[data-next],[data-back],[data-check],[data-confirm],#installBtn");
    if (!t) return;
    if (t.id === "installBtn") {
      if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; t.hidden = true; }
      return;
    }
    if (t.hasAttribute("data-book")) { var id = t.getAttribute("data-book"); openBooking(id || null); if (id) st.fromService = true; drawSheet(); return; }
    if (t.hasAttribute("data-close")) { closeBooking(); return; }
    if (t.hasAttribute("data-cancel")) {
      var cid = t.getAttribute("data-cancel");
      var list = loadBookings();
      var b = list.filter(function (x) { return x.id === cid; })[0];
      if (!b) return;
      b.status = "cancelled"; saveBookings(list);
      post({ type: "cancel", id: b.id, serviceName: b.serviceName, whenText: fmtLong(new Date(b.start)) + ", " + fmtTime(new Date(b.start)), name: b.name, phone: b.phone, car: b.car });
      toast("Запись отменена");
      render();
      return;
    }
    if (!st) return;
    if (t.hasAttribute("data-pick")) { st.service = serviceById(t.getAttribute("data-pick")); st.day = null; st.time = null; st.step = 2; st.fromService = false; drawSheet(); return; }
    if (t.hasAttribute("data-day")) { st.day = fromInputDate(t.getAttribute("data-day")); st.time = null; st.keepFocus = '.day[aria-pressed="true"]'; drawSheet(); return; }
    if (t.hasAttribute("data-time")) { st.time = t.getAttribute("data-time"); st.keepFocus = '.slot[aria-pressed="true"]'; drawSheet(); return; }
    if (t.hasAttribute("data-next")) { if (st.day && st.time) { st.step = 3; drawSheet(); } return; }
    if (t.hasAttribute("data-back")) { st.errors = {}; syncInputs(); if (st.step === 2) { st.step = 1; } else st.step -= 1; drawSheet(); return; }
    if (t.hasAttribute("data-check")) { syncInputs(); if (validateContacts()) st.step = 4; drawSheet(); return; }
    if (t.hasAttribute("data-confirm")) { confirmBooking(); return; }
  });

  function syncInputs() {
    var g = function (id) { var el = sheet.querySelector(id); return el ? el.value : null; };
    var n = g("#fName"), p = g("#fPhone"), c = g("#fCar"), pl = g("#fPlate"), hp = g("#fHp");
    if (n !== null) st.name = n;
    if (p !== null) st.phone = p;
    if (c !== null) st.car = c;
    if (pl !== null) st.plate = pl;
    if (hp !== null) st.hp = hp;
  }

  sheet.addEventListener("change", function (ev) {
    if (ev.target.id === "otherDate" && ev.target.value && st) {
      var d = fromInputDate(ev.target.value), today = startOfDay(new Date());
      if (d < today || d > addDays(today, S.maxDaysAhead)) return;
      st.day = d; st.time = null; st.keepFocus = "#otherDate"; drawSheet();
    }
  });

  document.addEventListener("keydown", function (ev) {
    if (root.hidden) return;
    if (ev.key === "Escape") { closeBooking(); return; }
    if (ev.key === "Tab") {
      var f = sheet.querySelectorAll('button:not([disabled]), a[href], input:not(.hp):not([disabled])');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
  });

  /* ---------- сервис-воркер ---------- */
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
  }

  render();
})();

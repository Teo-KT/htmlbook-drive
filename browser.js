/* ==========================================================================
   htmlbook-drive — 파일 탐색기(사이드바)
   파인더/탐색기처럼 폴더 트리를 펼치고 파일을 클릭해서 연다.
   섹션: 검색 · 고정한 폴더 · 별표 · 최근 문서 · 내 드라이브
   (SCOPE_MODE "full" 또는 "readonly" 에서만 동작)
   ========================================================================== */
(function () {
  "use strict";
  var H = window.HBD;
  if (!H) return;

  var API = "https://www.googleapis.com/drive/v3/files";
  var FOLDER = "application/vnd.google-apps.folder";
  var SHORTCUT = "application/vnd.google-apps.shortcut";
  var LIST_FIELDS = "files(id,name,mimeType,modifiedTime,shortcutDetails(targetId,targetMimeType))";
  var TEXT_EXT = /\.(html?|xhtml|md|markdown|mdown|mkd|txt)$/i;
  var TEXT_MIME = /^text\/(html|markdown|x-markdown|plain)$/i;

  var root = document.getElementById("tree-root");
  var searchInput = document.getElementById("tree-search");
  var searchResults = document.getElementById("search-results");
  var sections = document.getElementById("tree-sections");
  var cache = {};        // folderId -> { at, items }
  var CACHE_TTL = 5 * 60 * 1000;
  var loggedIn = false;

  function getPins() {
    try { return JSON.parse(localStorage.getItem("hbd-pins") || "[]"); } catch (e) { return []; }
  }
  function setPins(p) {
    try { localStorage.setItem("hbd-pins", JSON.stringify(p)); } catch (e) {}
    renderPins();
  }

  // ---- Drive 목록 조회 ----------------------------------------------------
  function listChildren(folderId) {
    var now = Date.now();
    if (cache[folderId] && now - cache[folderId].at < CACHE_TTL) {
      return Promise.resolve(cache[folderId].items);
    }
    var q = "'" + folderId.replace(/'/g, "\\'") + "' in parents and trashed=false";
    var url = API + "?q=" + encodeURIComponent(q) +
      "&orderBy=" + encodeURIComponent("folder,name_natural") +
      "&pageSize=1000&fields=" + encodeURIComponent(LIST_FIELDS) +
      "&supportsAllDrives=true&includeItemsFromAllDrives=true";
    return H.apiFetch(url)
      .then(function (r) { return H.handleApiResponse(r, true); })
      .then(function (j) {
        var items = (j.files || []).filter(keep);
        cache[folderId] = { at: Date.now(), items: items };
        return items;
      });
  }

  function keep(f) {
    if (f.mimeType === FOLDER) return true;
    if (f.mimeType === SHORTCUT) {
      var t = f.shortcutDetails || {};
      return t.targetMimeType === FOLDER || TEXT_MIME.test(t.targetMimeType || "") || TEXT_EXT.test(f.name || "");
    }
    return TEXT_MIME.test(f.mimeType || "") || TEXT_EXT.test(f.name || "");
  }

  function isFolder(f) {
    return f.mimeType === FOLDER ||
      (f.mimeType === SHORTCUT && f.shortcutDetails && f.shortcutDetails.targetMimeType === FOLDER);
  }
  function realId(f) {
    if (f.mimeType === SHORTCUT && f.shortcutDetails && f.shortcutDetails.targetId) return f.shortcutDetails.targetId;
    return f.id;
  }
  function fileIcon(name) {
    if (/\.(html?|xhtml)$/i.test(name)) return "🌐";
    if (/\.(md|markdown|mdown|mkd)$/i.test(name)) return "📝";
    return "📄";
  }

  // ---- 트리 렌더링 --------------------------------------------------------
  function nodeEl(f, depth) {
    var folder = isFolder(f);
    var div = document.createElement("div");
    div.className = "tnode " + (folder ? "folder" : "file");
    div.style.setProperty("--depth", depth);
    div.setAttribute("data-id", realId(f));

    var row = document.createElement("div");
    row.className = "trow";
    row.innerHTML = folder
      ? '<span class="caret">▸</span><span class="ticon">📁</span><span class="tname"></span>'
      : '<span class="caret"></span><span class="ticon">' + fileIcon(f.name) + '</span><span class="tname"></span>';
    row.querySelector(".tname").textContent = f.name;
    div.appendChild(row);

    if (folder) {
      var kids = document.createElement("div");
      kids.className = "tkids hidden";
      div.appendChild(kids);
      row.addEventListener("click", function () {
        var open = !kids.classList.contains("hidden");
        if (open) {
          kids.classList.add("hidden");
          row.querySelector(".caret").textContent = "▸";
        } else {
          row.querySelector(".caret").textContent = "▾";
          kids.classList.remove("hidden");
          if (!kids.hasChildNodes()) loadInto(kids, realId(f), depth + 1);
        }
      });
    } else {
      row.addEventListener("click", function () {
        H.loadFile(realId(f));
        if (window.innerWidth <= 900) H.setSidebar(false);
      });
    }
    return div;
  }

  function loadInto(container, folderId, depth) {
    var ld = document.createElement("div");
    ld.className = "tmsg";
    ld.textContent = "불러오는 중…";
    container.appendChild(ld);
    listChildren(folderId).then(function (items) {
      container.removeChild(ld);
      if (!items.length) {
        var e = document.createElement("div");
        e.className = "tmsg";
        e.textContent = "표시할 문서가 없습니다";
        container.appendChild(e);
        return;
      }
      items.forEach(function (f) { container.appendChild(nodeEl(f, depth)); });
      markActive(H.state.doc && H.state.doc.id);
    }).catch(function (err) {
      ld.textContent = "목록을 불러오지 못했습니다";
      ld.title = (err && err.message || "").replace(/<[^>]+>/g, "");
    });
  }

  function markActive(id) {
    var prev = sections.querySelectorAll(".trow.active");
    for (var i = 0; i < prev.length; i++) prev[i].classList.remove("active");
    if (!id) return;
    var nodes = sections.querySelectorAll('.tnode.file[data-id="' + id + '"] > .trow');
    for (var j = 0; j < nodes.length; j++) nodes[j].classList.add("active");
  }

  // ---- 섹션: 고정한 폴더 --------------------------------------------------
  function renderPins() {
    var wrap = document.getElementById("sec-pins");
    var body = wrap.querySelector(".sec-body");
    var pins = getPins();
    wrap.classList.toggle("hidden", pins.length === 0);
    body.innerHTML = "";
    pins.forEach(function (p) {
      var f = { id: p.id, name: p.name, mimeType: FOLDER };
      var node = nodeEl(f, 0);
      var un = document.createElement("button");
      un.className = "tact";
      un.title = "고정 해제";
      un.textContent = "✕";
      un.addEventListener("click", function (e) {
        e.stopPropagation();
        setPins(getPins().filter(function (x) { return x.id !== p.id; }));
      });
      node.querySelector(".trow").appendChild(un);
      body.appendChild(node);
    });
  }

  // ---- 섹션: 별표 / 최근 --------------------------------------------------
  function loadStarred() {
    var body = document.querySelector("#sec-starred .sec-body");
    body.innerHTML = '<div class="tmsg">불러오는 중…</div>';
    var q = "starred=true and trashed=false";
    var url = API + "?q=" + encodeURIComponent(q) + "&orderBy=" + encodeURIComponent("folder,name_natural") +
      "&pageSize=100&fields=" + encodeURIComponent(LIST_FIELDS) + "&supportsAllDrives=true&includeItemsFromAllDrives=true";
    H.apiFetch(url).then(function (r) { return H.handleApiResponse(r, true); }).then(function (j) {
      var items = (j.files || []).filter(keep);
      body.innerHTML = "";
      document.getElementById("sec-starred").classList.toggle("hidden", items.length === 0);
      items.forEach(function (f) { body.appendChild(nodeEl(f, 0)); });
    }).catch(function () { body.innerHTML = '<div class="tmsg">불러오지 못했습니다</div>'; });
  }

  function loadRecents() {
    var body = document.querySelector("#sec-recent .sec-body");
    body.innerHTML = '<div class="tmsg">불러오는 중…</div>';
    var q = "trashed=false and (mimeType='text/html' or mimeType='text/markdown' or mimeType='text/x-markdown' " +
      "or name contains '.html' or name contains '.md')";
    var url = API + "?q=" + encodeURIComponent(q) + "&orderBy=" + encodeURIComponent("viewedByMeTime desc") +
      "&pageSize=30&fields=" + encodeURIComponent(LIST_FIELDS) + "&supportsAllDrives=true&includeItemsFromAllDrives=true";
    H.apiFetch(url).then(function (r) { return H.handleApiResponse(r, true); }).then(function (j) {
      var items = (j.files || []).filter(function (f) { return keep(f) && !isFolder(f); }).slice(0, 15);
      body.innerHTML = "";
      if (!items.length) body.innerHTML = '<div class="tmsg">최근 연 문서가 없습니다</div>';
      items.forEach(function (f) { body.appendChild(nodeEl(f, 0)); });
      markActive(H.state.doc && H.state.doc.id);
    }).catch(function () { body.innerHTML = '<div class="tmsg">불러오지 못했습니다</div>'; });
  }

  // ---- 검색 ---------------------------------------------------------------
  var searchTimer = null;
  function onSearchInput() {
    if (searchTimer) clearTimeout(searchTimer);
    var term = searchInput.value.trim();
    if (!term) { showSearch(false); return; }
    searchTimer = setTimeout(function () { runSearch(term); }, 350);
  }
  function showSearch(on) {
    searchResults.classList.toggle("hidden", !on);
    sections.classList.toggle("hidden", on);
  }
  function runSearch(term) {
    showSearch(true);
    searchResults.innerHTML = '<div class="tmsg">검색 중…</div>';
    var esc = term.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    var q = "trashed=false and name contains '" + esc + "'";
    var url = API + "?q=" + encodeURIComponent(q) + "&pageSize=100&orderBy=" + encodeURIComponent("folder,name_natural") +
      "&fields=" + encodeURIComponent(LIST_FIELDS) + "&supportsAllDrives=true&includeItemsFromAllDrives=true";
    H.apiFetch(url).then(function (r) { return H.handleApiResponse(r, true); }).then(function (j) {
      var items = (j.files || []).filter(keep);
      searchResults.innerHTML = "";
      if (!items.length) {
        searchResults.innerHTML = '<div class="tmsg">결과가 없습니다</div>';
        return;
      }
      items.forEach(function (f) {
        var node = nodeEl(f, 0);
        if (isFolder(f)) {
          var pin = document.createElement("button");
          pin.className = "tact";
          pin.title = "사이드바에 고정";
          pin.textContent = "📌";
          pin.addEventListener("click", function (e) {
            e.stopPropagation();
            var pins = getPins();
            if (!pins.some(function (x) { return x.id === realId(f); })) {
              pins.push({ id: realId(f), name: f.name });
              setPins(pins);
            }
            searchInput.value = "";
            showSearch(false);
          });
          node.querySelector(".trow").appendChild(pin);
        }
        searchResults.appendChild(node);
      });
    }).catch(function () { searchResults.innerHTML = '<div class="tmsg">검색에 실패했습니다</div>'; });
  }

  // ---- 진입점 -------------------------------------------------------------
  function onLogin() {
    if (loggedIn || !H.CAN_BROWSE) return;
    loggedIn = true;
    document.getElementById("sidebar-login").classList.add("hidden");
    sections.classList.remove("hidden");
    renderPins();
    loadStarred();
    loadRecents();
    loadInto(root, "root", 0);
    if (window.innerWidth > 900) H.setSidebar(true);
  }

  function refreshAll() {
    if (!loggedIn) return;
    for (var k in cache) delete cache[k];
    root.innerHTML = "";
    loadStarred();
    loadRecents();
    loadInto(root, "root", 0);
  }

  searchInput.addEventListener("input", onSearchInput);
  searchInput.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { searchInput.value = ""; showSearch(false); }
  });
  document.getElementById("tree-refresh").addEventListener("click", refreshAll);
  document.getElementById("sidebar-login-btn").addEventListener("click", function () { H.login(); });

  H.browser = { onLogin: onLogin, markActive: markActive, refreshAll: refreshAll };
})();

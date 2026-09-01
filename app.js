/* ==========================================================================
   htmlbook-drive — 코어 (설정·인증·파일 IO·렌더링·테마)
   - 공유 링크(붙여넣기) 모드: API 키로 공개 파일 열람
   - 로그인 모드: Google OAuth(GIS)로 내 드라이브 탐색·열람·편집
   서버 없이 브라우저에서만 동작. 파일 탐색은 browser.js, 편집은 editor.js.
   ========================================================================== */
(function () {
  "use strict";

  var CFG = window.HTMLBOOK_DRIVE_CONFIG || {};

  // ---- 권한 범위 ----------------------------------------------------------
  // SCOPE_MODE: "full"(읽기+쓰기, 파일트리·편집 가능) | "readonly"(전체 읽기)
  //             | "file"(Picker 로 고른 파일만) — 구 READONLY_SCOPE 도 인식.
  var SCOPE_MODE = CFG.SCOPE_MODE || (CFG.READONLY_SCOPE === true ? "readonly" : "file");
  var SCOPES = {
    full: "https://www.googleapis.com/auth/drive",
    readonly: "https://www.googleapis.com/auth/drive.readonly",
    file: "https://www.googleapis.com/auth/drive.file",
  };
  var SCOPE = SCOPES[SCOPE_MODE] || SCOPES.file;
  var CAN_BROWSE = SCOPE_MODE === "full" || SCOPE_MODE === "readonly";
  var CAN_WRITE = SCOPE_MODE === "full";

  function isSet(v) {
    return typeof v === "string" && v.length > 0 && v.indexOf("YOUR_") === -1;
  }
  var HAS_API_KEY = isSet(CFG.API_KEY);
  var HAS_OAUTH = isSet(CFG.CLIENT_ID) && isSet(CFG.APP_ID);

  // ---- DOM 참조 -----------------------------------------------------------
  var el = {
    sidebarToggle: document.getElementById("sidebar-toggle"),
    linkInput: document.getElementById("link-input"),
    openLinkBtn: document.getElementById("open-link"),
    loginBtn: document.getElementById("login-btn"),
    themeBtn: document.getElementById("theme-btn"),
    scriptToggle: document.getElementById("script-toggle"),
    scriptLabel: document.getElementById("script-label"),
    widthBtn: document.getElementById("width-btn"),
    fontMinus: document.getElementById("font-minus"),
    fontPlus: document.getElementById("font-plus"),
    banner: document.getElementById("banner"),
    hero: document.getElementById("hero"),
    loading: document.getElementById("loading"),
    viewer: document.getElementById("viewer"),
    docName: document.getElementById("doc-name"),
    docKind: document.getElementById("doc-kind"),
    htmlFrame: document.getElementById("html-frame"),
    mdBody: document.getElementById("md-body"),
    demoMd: document.getElementById("demo-md"),
    demoHtml: document.getElementById("demo-html"),
    setupNote: document.getElementById("setup-note"),
    modeSeg: document.getElementById("mode-seg"),
    saveChip: document.getElementById("save-chip"),
    sessionChip: document.getElementById("session-chip"),
    sidebar: document.getElementById("sidebar"),
    sidebarScrim: document.getElementById("sidebar-scrim"),
  };

  // ---- 전역 상태 ----------------------------------------------------------
  var state = {
    token: null,          // { t, exp(ms) }
    doc: null,            // { id, name, mimeType, text, type, version, canEdit }
    mode: "view",         // view | inline | source
    readScale: 100,       // 본문 글자 크기(%)
    needsLogin: false,    // 조용한 갱신 실패 → 사용자 클릭 필요
  };
  var pendingFileId = null;
  var tokenClient = null;
  var pendingTokenWaiters = [];   // [{resolve, reject}]
  var refreshTimer = null;
  var pickerApiLoaded = false;

  // ==========================================================================
  // 토큰 관리 — "빠른 로그아웃" 개선의 핵심
  //  - localStorage 보관: 탭을 닫거나 브라우저를 재시작해도 만료 전이면 유지
  //  - 만료 5분 전 + 탭 복귀 시 조용한 갱신(prompt:"") 시도
  //  - 갱신 팝업이 차단되면 "세션 연장" 칩을 띄워 클릭 한 번으로 연장
  //  - API 401 시 자동 갱신 후 1회 재시도
  // ==========================================================================
  function saveToken(tok, expiresInSec) {
    var exp = Date.now() + Math.max(0, (Number(expiresInSec) || 3600) - 60) * 1000;
    state.token = { t: tok, exp: exp };
    try { localStorage.setItem("hbd-token", JSON.stringify(state.token)); } catch (e) {}
    scheduleRefresh();
  }
  function restoreToken() {
    try {
      var raw = localStorage.getItem("hbd-token");
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.t || Date.now() > o.exp) { localStorage.removeItem("hbd-token"); return null; }
      return o;
    } catch (e) { return null; }
  }
  function tokenValid() { return !!(state.token && state.token.t && Date.now() < state.token.exp); }
  function getToken() { return tokenValid() ? state.token.t : null; }

  function getHint() {
    try { return localStorage.getItem("hbd-hint") || undefined; } catch (e) { return undefined; }
  }
  function saveHint(email) {
    try { if (email) localStorage.setItem("hbd-hint", email); } catch (e) {}
  }

  function initTokenClient() {
    if (tokenClient || !HAS_OAUTH || !window.google || !google.accounts || !google.accounts.oauth2) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.CLIENT_ID,
      scope: SCOPE,
      callback: function (resp) {
        var waiters = pendingTokenWaiters.splice(0);
        if (resp && resp.access_token) {
          saveToken(resp.access_token, resp.expires_in);
          onLoggedIn();
          waiters.forEach(function (w) { w.resolve(resp.access_token); });
        } else {
          var err = new AppError("로그인 응답에 토큰이 없습니다.");
          waiters.forEach(function (w) { w.reject(err); });
        }
      },
      error_callback: function (err) {
        var waiters = pendingTokenWaiters.splice(0);
        var e = new AppError("로그인이 취소되었거나 차단되었습니다." + (err && err.type ? " (" + err.type + ")" : ""));
        e.gsiType = err && err.type;
        waiters.forEach(function (w) { w.reject(e); });
      },
    });
  }

  // prompt:"" — 구글 세션이 살아 있고 기존에 동의했다면 팝업이 떴다 바로 닫히며
  // 새 토큰을 받는다. 사용자 제스처 밖에서 호출하면 팝업이 차단될 수 있는데,
  // 그 경우 조용히 실패시키고 "세션 연장" 칩으로 유도한다.
  function requestToken() {
    return new Promise(function (resolve, reject) {
      initTokenClient();
      if (!tokenClient) return reject(new AppError("구글 로그인 라이브러리를 아직 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."));
      pendingTokenWaiters.push({ resolve: resolve, reject: reject });
      try {
        tokenClient.requestAccessToken({ prompt: "", login_hint: getHint() });
      } catch (e) {
        pendingTokenWaiters.pop();
        reject(e);
      }
    });
  }

  function ensureToken() {
    if (tokenValid()) return Promise.resolve(state.token.t);
    return requestToken();
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    if (!tokenValid()) return;
    var lead = state.token.exp - Date.now() - 5 * 60 * 1000; // 만료 5분 전
    refreshTimer = setTimeout(function () {
      if (document.visibilityState !== "visible") return; // 복귀 시 visibilitychange 가 처리
      requestToken().catch(function () { setNeedsLogin(true); });
    }, Math.max(5000, lead));
  }

  function setNeedsLogin(on) {
    state.needsLogin = on;
    el.sessionChip.classList.toggle("hidden", !on);
  }

  function onLoggedIn() {
    setNeedsLogin(false);
    el.loginBtn.textContent = "로그인됨 ✓";
    el.loginBtn.classList.add("ok");
    // login_hint 용 이메일 1회 확보(다음 갱신부터 계정 선택 화면 생략)
    if (!getHint()) {
      apiFetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)")
        .then(function (r) { return r.json(); })
        .then(function (j) { saveHint(j && j.user && j.user.emailAddress); })
        .catch(function () {});
    }
    if (window.HBD && HBD.browser && CAN_BROWSE) HBD.browser.onLogin();
    if (pendingFileId) {
      var id = pendingFileId; pendingFileId = null;
      loadFile(id);
    }
  }

  function login() {
    if (!HAS_OAUTH) { showSetupNeeded(); return; }
    requestToken().catch(function (e) {
      showBanner((e && e.message) || "로그인에 실패했습니다.", true);
    });
  }

  // 인증 포함 fetch. 401 이면 조용한 갱신 후 1회 재시도.
  function apiFetch(url, opts, isRetry) {
    opts = opts || {};
    return ensureToken().then(function (tok) {
      var headers = Object.assign({}, opts.headers, { Authorization: "Bearer " + tok });
      return fetch(url, Object.assign({}, opts, { headers: headers }));
    }).then(function (r) {
      if (r.status === 401 && !isRetry) {
        state.token = null;
        try { localStorage.removeItem("hbd-token"); } catch (e) {}
        return apiFetch(url, opts, true);
      }
      return r;
    });
  }

  // 탭 복귀 시: 토큰이 만료됐거나 임박하면 갱신 시도
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    if (!getHint() && !tokenValid()) return; // 로그인한 적 없음
    var nearExp = !tokenValid() || (state.token.exp - Date.now() < 5 * 60 * 1000);
    if (nearExp) requestToken().catch(function () { setNeedsLogin(true); });
  });

  // ---- UI 상태 도우미 -----------------------------------------------------
  function showBanner(msg, isError) {
    el.banner.innerHTML = msg;
    el.banner.className = "banner" + (isError ? " error" : "");
  }
  function hideBanner() { el.banner.className = "banner hidden"; }
  function setLoading(on) { el.loading.classList.toggle("hidden", !on); }
  function showHero(on) { el.hero.classList.toggle("hidden", !on); }
  function showViewer(on) { el.viewer.classList.toggle("hidden", !on); }

  // ---- 링크 → fileId 추출 -------------------------------------------------
  function parseFileId(raw) {
    if (!raw) return null;
    var s = String(raw).trim();
    var m = s.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
    if (m) return m[1];
    m = s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
    if (m) return m[1];
    if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
    return null;
  }

  // ---- Drive 파일 IO ------------------------------------------------------
  function AppError(msg) { this.name = "AppError"; this.message = msg; }
  AppError.prototype = Object.create(Error.prototype);

  function handleApiResponse(r, hadToken) {
    if (r.ok) return r.json();
    return r.text().then(function () {
      if (r.status === 404) {
        throw new AppError(
          "파일을 찾을 수 없습니다(404). 링크가 올바른지, 그리고 " +
          (hadToken ? "선택한 파일에 접근 권한이 있는지"
                    : "파일이 <b>‘링크가 있는 모든 사용자’</b>로 공유되어 있는지") + " 확인하세요.");
      }
      if (r.status === 403 || r.status === 401) {
        throw new AppError(
          hadToken
            ? "접근이 거부되었습니다(" + r.status + "). 이 파일을 열 권한이 없거나 로그인이 만료되었습니다. 다시 로그인해 보세요."
            : "비공개 파일이거나 접근이 거부되었습니다(" + r.status + ").<br>" +
              "공유 링크 방식은 <b>‘링크가 있는 모든 사용자’</b>로 공유된 파일만 열 수 있습니다. " +
              "비공개 파일은 상단의 <b>구글 로그인</b>을 사용하세요.");
      }
      throw new AppError("드라이브 요청 실패 (" + r.status + ").");
    });
  }

  function fetchDriveFile(id) {
    var useToken = tokenValid() || getHint(); // 로그인 이력 있으면 토큰 경로
    var base = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id);
    var metaQ = "?fields=name,mimeType,size,version,capabilities(canEdit),shortcutDetails";
    var doFetch = useToken
      ? function (u) { return apiFetch(u); }
      : function (u) { return fetch(u + (u.indexOf("?") >= 0 ? "&" : "?") + "key=" + encodeURIComponent(CFG.API_KEY)); };

    var meta = null;
    return doFetch(base + metaQ)
      .then(function (r) { return handleApiResponse(r, !!useToken); })
      .then(function (m) {
        // 바로가기(shortcut)면 대상 파일로 넘어간다
        if (m.mimeType === "application/vnd.google-apps.shortcut" && m.shortcutDetails && m.shortcutDetails.targetId) {
          return fetchDriveFile(m.shortcutDetails.targetId);
        }
        meta = m;
        if (m.mimeType && m.mimeType.indexOf("application/vnd.google-apps") === 0) {
          throw new AppError(
            "이 파일은 <b>구글 문서/시트/슬라이드</b> 형식입니다. 이 뷰어는 업로드된 " +
            "<b>HTML/Markdown 파일</b>만 지원합니다. (구글 문서는 드라이브에서 " +
            "<code>파일 → 다운로드 → 웹페이지(.html)</code> 로 내보낸 뒤 사용하세요.)");
        }
        return doFetch(base + "?alt=media").then(function (r) {
          if (!r.ok) return handleApiResponse(r, !!useToken);
          return r.text();
        }).then(function (text) {
          return {
            id: id,
            name: meta.name || "(제목 없음)",
            mimeType: meta.mimeType || "",
            version: meta.version || null,
            canEdit: !!(meta.capabilities && meta.capabilities.canEdit) && CAN_WRITE,
            text: text,
          };
        });
      });
  }

  // 저장(미디어 업로드). editor.js 의 자동 저장이 사용한다.
  function saveDriveFile(id, text, mimeType, opts) {
    var url = "https://www.googleapis.com/upload/drive/v3/files/" + encodeURIComponent(id) +
      "?uploadType=media&fields=version,modifiedTime";
    return apiFetch(url, {
      method: "PATCH",
      headers: { "Content-Type": (mimeType || "text/plain") + "; charset=UTF-8" },
      body: text,
      keepalive: !!(opts && opts.keepalive),
    }).then(function (r) {
      if (!r.ok) return handleApiResponse(r, true);
      return r.json();
    });
  }

  function getFileVersion(id) {
    return apiFetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) + "?fields=version,modifiedTime")
      .then(function (r) { return handleApiResponse(r, true); });
  }

  // ---- 포맷 판별 ----------------------------------------------------------
  function detectType(name, mimeType, text) {
    var n = (name || "").toLowerCase();
    var mt = (mimeType || "").toLowerCase();
    if (mt === "text/html" || /\.(html?|xhtml)$/.test(n)) return "html";
    if (mt === "text/markdown" || mt === "text/x-markdown" || /\.(md|markdown|mdown|mkd)$/.test(n)) return "md";
    var head = (text || "").slice(0, 800).toLowerCase();
    if (head.indexOf("<!doctype html") !== -1 || /<html[\s>]/.test(head) || /<body[\s>]/.test(head)) return "html";
    return "md";
  }

  // ---- 읽기 테마(종이/세피아/다크) + 글자 크기 ----------------------------
  // htmlbook.io 벤치마킹: 스타일 없는 문서는 리더가 테마를 입히고,
  // 자체 스타일이 있는 문서는 원본 그대로 둔다.
  var THEME_CYCLE = ["light", "sepia", "dark"];
  function currentTheme() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t) return t;
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  }
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("hbd-theme", t); } catch (e) {}
    // 열려 있는 "테마 입힌 HTML" 은 다시 렌더해 반영
    if (state.doc && state.doc.type === "html" && state.mode === "view" && lastRenderBare) renderHtml(state.doc.text);
  }
  function toggleTheme() {
    var i = THEME_CYCLE.indexOf(currentTheme());
    applyTheme(THEME_CYCLE[(i + 1) % THEME_CYCLE.length]);
  }
  (function initTheme() {
    try {
      var saved = localStorage.getItem("hbd-theme");
      if (saved) document.documentElement.setAttribute("data-theme", saved);
    } catch (e) {}
  })();

  function setReadScale(pct) {
    state.readScale = Math.min(140, Math.max(80, pct));
    try { localStorage.setItem("hbd-scale", String(state.readScale)); } catch (e) {}
    document.documentElement.style.setProperty("--read-scale", state.readScale / 100);
    if (state.doc && state.doc.type === "html" && lastRenderBare && state.mode === "view") renderHtml(state.doc.text);
  }

  // 문서에 자체 스타일이 없으면 true → 리더 테마를 입힌다
  function isBareHtml(dom) {
    if (dom.querySelector("style,link[rel~='stylesheet']")) return false;
    if (dom.querySelectorAll("[style]").length >= 3) return false;
    return true;
  }

  // 리더 테마 CSS (iframe 주입용) — 현재 테마의 CSS 변수 값을 그대로 가져온다
  function readerCss() {
    var cs = getComputedStyle(document.documentElement);
    function v(name, fb) { return (cs.getPropertyValue(name) || fb).trim(); }
    return "html{font-size:" + (state.readScale / 100 * 100) + "%}" +
      "body{margin:0 auto;max-width:760px;padding:40px 28px 64px;" +
      "background:" + v("--bg-elev", "#fff") + ";color:" + v("--text", "#1f2328") + ";" +
      "font-family:" + v("--font-read", "Georgia,serif") + ";font-size:1.06rem;line-height:1.75;word-break:keep-all;overflow-wrap:anywhere}" +
      "h1,h2,h3,h4,h5,h6{font-family:" + v("--font-ui", "sans-serif") + ";line-height:1.3;letter-spacing:-.015em;margin:1.6em 0 .55em}" +
      "h1{font-size:1.8em;border-bottom:1px solid " + v("--border", "#ddd") + ";padding-bottom:.3em}" +
      "h2{font-size:1.45em;border-bottom:1px solid " + v("--border", "#ddd") + ";padding-bottom:.25em}" +
      "h3{font-size:1.2em}p{margin:0 0 1.05em}a{color:" + v("--link", "#0969da") + "}" +
      "img{max-width:100%;height:auto;border-radius:8px}" +
      "blockquote{margin:1.2em 0;padding:.2em 1.1em;border-left:4px solid " + v("--accent", "#2f6feb") + ";color:" + v("--text-soft", "#666") + ";background:" + v("--bg-soft", "#f6f7f9") + ";border-radius:0 8px 8px 0}" +
      "code{font-family:" + v("--font-mono", "monospace") + ";font-size:.86em;background:" + v("--code-bg", "#f2f4f7") + ";padding:.18em .4em;border-radius:5px}" +
      "pre{background:" + v("--code-bg", "#f2f4f7") + ";padding:16px 18px;border-radius:10px;overflow-x:auto;border:1px solid " + v("--border", "#ddd") + "}" +
      "pre code{background:none;padding:0}" +
      "table{border-collapse:collapse;max-width:100%;overflow-x:auto;display:block;font-family:" + v("--font-ui", "sans-serif") + ";font-size:.9em}" +
      "th,td{border:1px solid " + v("--border", "#ddd") + ";padding:8px 12px;text-align:left}" +
      "th{background:" + v("--bg-soft", "#f6f7f9") + "}" +
      "hr{border:none;border-top:1px solid " + v("--border", "#ddd") + ";margin:2em 0}";
  }

  // ---- 렌더링 -------------------------------------------------------------
  var lastDoc = null;          // 마지막으로 연 문서(스크립트 토글 재렌더용)
  var lastRenderBare = false;  // 마지막 HTML 렌더가 "테마 입힌 문서 모드"였는지
  var currentBlobUrl = null;

  function render(doc, opts) {
    opts = opts || {};
    lastDoc = doc;
    var type = detectType(doc.name, doc.mimeType, doc.text);
    doc.type = type;

    el.docName.textContent = doc.name;
    el.docKind.textContent = type === "html" ? "HTML" : "Markdown";

    if (!opts.preview) {
      hideBanner();
      showHero(false);
      setLoading(false);
      showViewer(true);
    }

    if (type === "html") {
      renderHtml(doc.text);
      el.htmlFrame.classList.remove("hidden");
      el.mdBody.classList.add("hidden");
      el.scriptLabel.classList.toggle("hidden", lastRenderBare);
      el.widthBtn.classList.add("hidden");
    } else {
      renderMarkdown(doc.text);
      el.mdBody.classList.remove("hidden");
      el.htmlFrame.classList.add("hidden");
      el.scriptLabel.classList.add("hidden");
      el.widthBtn.classList.remove("hidden");
    }
    document.body.classList.toggle("html-mode", type === "html");
    if (!opts.preview) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderHtml(htmlText, extra) {
    extra = extra || {};
    var allowScripts = el.scriptToggle.checked && !extra.stripScripts;
    var sandbox = allowScripts
      ? "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals"
      : "allow-popups allow-popups-to-escape-sandbox allow-forms allow-same-origin";
    if (extra.sandbox) sandbox = extra.sandbox;

    var out = htmlText;
    lastRenderBare = false;
    try {
      var doc = new DOMParser().parseFromString(htmlText, "text/html");

      if (extra.stripScripts) {
        // 편집 모드: 문서 스크립트·이벤트 핸들러 제거(우리 에디터 스크립트만 실행)
        var scripts = doc.querySelectorAll("script");
        for (var s = 0; s < scripts.length; s++) scripts[s].parentNode.removeChild(scripts[s]);
        var all = doc.querySelectorAll("*");
        for (var a = 0; a < all.length; a++) {
          var attrs = all[a].attributes;
          for (var k = attrs.length - 1; k >= 0; k--) {
            if (/^on/i.test(attrs[k].name)) all[a].removeAttribute(attrs[k].name);
          }
        }
      }

      // 스타일 없는 "맨몸" HTML 이면 리더 테마 주입 (htmlbook.io 의 hb-doc 방식)
      if (isBareHtml(doc)) {
        lastRenderBare = true;
        var st = doc.createElement("style");
        st.setAttribute("data-hbd-reader", "1");
        st.textContent = readerCss();
        (doc.head || doc.documentElement).appendChild(st);
        var mv = doc.createElement("meta");
        mv.setAttribute("name", "viewport");
        mv.setAttribute("content", "width=device-width, initial-scale=1");
        (doc.head || doc.documentElement).appendChild(mv);
      }

      // 링크 선별 처리: 문서 내 앵커(#)는 프레임 안에서 이동, 그 외에는 새 탭.
      var links = doc.querySelectorAll("a[href]");
      for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute("href") || "";
        if (href.charAt(0) === "#") continue;
        links[i].setAttribute("target", "_blank");
        links[i].setAttribute("rel", "noopener noreferrer");
      }

      if (extra.decorate) extra.decorate(doc);

      if (!extra.stripScripts && allowScripts) {
        // 스크립트 허용 모드(불투명 출처)용 앵커 헬퍼.
        // 차단 모드에선 same-origin 이라 앵커가 원래 동작하므로 주입하지 않는다(콘솔 소음 방지).
        var helper = doc.createElement("script");
        helper.textContent =
          "(function(){document.addEventListener('click',function(ev){" +
          "if(ev.defaultPrevented)return;" +
          "var n=ev.target;while(n&&n.tagName!=='A')n=n.parentNode;" +
          "if(!n)return;var h=n.getAttribute('href')||'';if(h.charAt(0)!=='#')return;" +
          "var id;try{id=decodeURIComponent(h.slice(1));}catch(e){id=h.slice(1);}" +
          "var t=document.getElementById(id)||document.getElementsByName(id)[0];" +
          "if(t){ev.preventDefault();t.scrollIntoView();}},false);})();";
        if (doc.body) doc.body.appendChild(helper);
      }
      out = "<!doctype html>\n" + doc.documentElement.outerHTML;
    } catch (e) { /* 파싱 실패 시 원본 그대로 */ }

    el.htmlFrame.setAttribute("sandbox", sandbox);
    if (currentBlobUrl) { try { URL.revokeObjectURL(currentBlobUrl); } catch (e2) {} }
    currentBlobUrl = URL.createObjectURL(new Blob([out], { type: "text/html;charset=utf-8" }));
    el.htmlFrame.removeAttribute("srcdoc");
    el.htmlFrame.src = currentBlobUrl;
  }

  function renderMarkdown(mdText) {
    var rawHtml = window.marked.parse(mdText, { gfm: true, breaks: false });
    var clean = window.DOMPurify.sanitize(rawHtml, { ADD_ATTR: ["target"] });
    el.mdBody.innerHTML = clean;
    var links = el.mdBody.querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute("href") || "";
      if (href.charAt(0) === "#") continue;
      links[i].setAttribute("target", "_blank");
      links[i].setAttribute("rel", "noopener noreferrer");
    }
  }

  // ---- 파일 열기 ----------------------------------------------------------
  function loadFile(id) {
    if (window.HBD && HBD.editor) HBD.editor.closeIfOpen();
    setLoading(true);
    showHero(false);
    showViewer(false);
    hideBanner();
    fetchDriveFile(id)
      .then(function (doc) {
        state.doc = doc;
        state.mode = "view";
        render(doc);
        updateModeSeg();
        try { history.replaceState(null, "", "#f=" + doc.id); } catch (e) {}
        if (window.HBD && HBD.browser) HBD.browser.markActive(doc.id);
      })
      .catch(function (e) {
        setLoading(false);
        showViewer(false);
        showHero(true);
        document.body.classList.remove("html-mode");
        showBanner((e && e.message) || "파일을 여는 중 오류가 발생했습니다.", true);
      });
  }

  function openFromLink() {
    var id = parseFileId(el.linkInput.value);
    if (!id) {
      showBanner("드라이브 링크를 인식하지 못했습니다. 파일의 <b>공유 링크</b> 또는 파일 ID를 붙여넣어 주세요.", true);
      return;
    }
    if (!tokenValid() && HAS_OAUTH && CAN_BROWSE) {
      pendingFileId = id;
      login();
      return;
    }
    if (!HAS_API_KEY && !tokenValid()) {
      showBanner("공유 링크로 열려면 <code>config.js</code> 에 <b>API 키</b>가 필요합니다. 또는 <b>구글 로그인</b>을 사용하세요.", true);
      return;
    }
    loadFile(id);
  }

  // ---- 모드 전환(보기/본문 편집/소스) — editor.js 가 실제 동작 담당 --------
  function updateModeSeg() {
    var doc = state.doc;
    var canEdit = !!(doc && doc.id !== "demo" && doc.canEdit);
    el.modeSeg.classList.toggle("hidden", !doc);
    var btns = el.modeSeg.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var m = btns[i].getAttribute("data-mode");
      btns[i].classList.toggle("active", state.mode === m);
      if (m !== "view") btns[i].disabled = !canEdit;
      // 본문(인라인) 편집은 HTML 만. 마크다운은 소스 편집이 곧 편집.
      if (m === "inline") btns[i].classList.toggle("hidden", !doc || doc.type !== "html");
      if (m === "source") btns[i].textContent = (doc && doc.type === "md") ? "편집" : "소스";
    }
    el.modeSeg.title = canEdit ? "" :
      (CAN_WRITE ? "이 파일에는 수정 권한이 없습니다" : "편집하려면 config.js 의 SCOPE_MODE 를 \"full\" 로 설정하세요");
  }

  function setMode(m) {
    if (!state.doc) return;
    if (m === state.mode) return;
    if (!window.HBD || !HBD.editor) return;
    HBD.editor.setMode(m);
    updateModeSeg();
  }

  // ---- Google Picker (SCOPE_MODE "file" 전용 폴백) -------------------------
  function ensurePicker() {
    return new Promise(function (resolve, reject) {
      if (pickerApiLoaded && window.google && google.picker) return resolve();
      if (!window.gapi) return reject(new AppError("Picker 라이브러리를 불러오지 못했습니다."));
      gapi.load("picker", {
        callback: function () { pickerApiLoaded = true; resolve(); },
        onerror: function () { reject(new AppError("Picker 로드 실패")); },
      });
    });
  }
  function openPicker() {
    ensureToken().then(function (tok) {
      return ensurePicker().then(function () {
        var view = new google.picker.DocsView(google.picker.ViewId.DOCS)
          .setMimeTypes("text/html,text/markdown,text/x-markdown,text/plain,application/octet-stream")
          .setIncludeFolders(true).setSelectFolderEnabled(false)
          .setMode(google.picker.DocsViewMode.LIST);
        new google.picker.PickerBuilder()
          .setAppId(CFG.APP_ID).setOAuthToken(tok).setDeveloperKey(CFG.API_KEY)
          .addView(view).setTitle("HTML / Markdown 파일 선택")
          .setCallback(function (data) {
            if (data && data.action === google.picker.Action.PICKED && data.docs && data.docs[0]) loadFile(data.docs[0].id);
          }).build().setVisible(true);
      });
    }).catch(function (e) { showBanner((e && e.message) || "파일 선택창을 열지 못했습니다.", true); });
  }

  // ---- 데모 ---------------------------------------------------------------
  var DEMO_MD = [
    "# htmlbook-drive 데모",
    "",
    "구글 드라이브의 `.md` 파일은 이렇게 읽기 좋은 형태로 렌더링됩니다.",
    "",
    "## 주요 기능",
    "",
    "- 왼쪽 **파일 탐색기**에서 폴더를 열고 파일을 클릭해서 봅니다",
    "- **편집** 모드에서 고치면 몇 초 뒤 드라이브에 **자동 저장**됩니다",
    "- HTML 문서는 화면을 **탭해서 바로 고치는** 본문 편집을 지원합니다",
    "",
    "> 파일의 공개 여부는 전적으로 구글 드라이브의 공유 설정이 결정합니다.",
    "",
    "```js",
    "function hello(name) { return `안녕하세요, ${name}!`; }",
    "```",
    "",
    "| 모드 | 대상 | 방식 |",
    "|------|------|------|",
    "| 본문 편집 | HTML | 화면에서 텍스트를 탭해 수정 |",
    "| 소스 편집 | HTML·MD | 코드 편집기 + 실시간 미리보기 |",
    "",
  ].join("\n");

  var DEMO_HTML = [
    "<!doctype html><html lang='ko'><head><meta charset='utf-8'>",
    "<style>",
    "  body{font-family:Georgia,serif;max-width:640px;margin:40px auto;padding:0 20px;line-height:1.7;color:#222;background:#fff}",
    "  h1{font-family:system-ui,sans-serif;color:#2f6feb}",
    "  .box{background:#f2f4f7;border-left:4px solid #2f6feb;padding:12px 16px;border-radius:6px}",
    "  code{background:#eef;padding:2px 6px;border-radius:4px}",
    "</style></head><body>",
    "<h1>HTML 데모 문서</h1>",
    "<p>이건 <b>HTML 파일</b>이 <i>원본 서식 그대로</i> 렌더링되는 예시입니다. ",
    "인라인 <code>&lt;style&gt;</code> 이 그대로 적용됩니다.</p>",
    "<div class='box'>자체 스타일이 있는 HTML 은 원본 그대로, 스타일이 없는 HTML 은 리더가 테마를 입혀 보여줍니다.</div>",
    "<ul><li>서식 보존</li><li>표 · 이미지 · 스타일 유지</li><li>본문 편집 모드에서 텍스트 탭 → 즉시 수정</li></ul>",
    "</body></html>",
  ].join("\n");

  function openDemo(kind) {
    if (window.HBD && HBD.editor) HBD.editor.closeIfOpen();
    state.doc = {
      id: "demo",
      name: kind === "html" ? "데모 문서.html" : "데모 문서.md",
      mimeType: kind === "html" ? "text/html" : "text/markdown",
      text: kind === "html" ? DEMO_HTML : DEMO_MD,
      canEdit: false,
    };
    state.mode = "view";
    render(state.doc);
    updateModeSeg();
  }

  function showSetupNeeded() {
    showBanner(
      "구글 연동을 사용하려면 <code>config.js</code> 에 <b>CLIENT_ID / API_KEY / APP_ID</b> 를 " +
      "먼저 설정해야 합니다. 설정 방법은 저장소의 <b>README</b> 를 참고하세요.", true);
  }

  // ---- 사이드바 토글 ------------------------------------------------------
  function setSidebar(open) {
    document.body.classList.toggle("sidebar-open", open);
    try { localStorage.setItem("hbd-sidebar", open ? "1" : "0"); } catch (e) {}
  }
  function toggleSidebar() { setSidebar(!document.body.classList.contains("sidebar-open")); }

  // ---- 초기화 -------------------------------------------------------------
  function init() {
    el.openLinkBtn.addEventListener("click", openFromLink);
    el.linkInput.addEventListener("keydown", function (e) { if (e.key === "Enter") openFromLink(); });
    el.loginBtn.addEventListener("click", login);
    el.themeBtn.addEventListener("click", toggleTheme);
    el.sessionChip.addEventListener("click", function () {
      requestToken().catch(function (e) { showBanner((e && e.message) || "세션 연장에 실패했습니다.", true); });
    });
    el.demoMd.addEventListener("click", function () { openDemo("md"); });
    el.demoHtml.addEventListener("click", function () { openDemo("html"); });
    // 스크립트 기본 허용: 본문을 JS 로 그리는 앱형 HTML(탭·차트·인터랙션)이
    // 원본 그대로 동작한다(htmlbook.io 의 독립 페이지 방식). 샌드박스(불투명
    // 출처)라 문서 스크립트는 이 페이지·드라이브 토큰에 접근할 수 없다.
    try { el.scriptToggle.checked = localStorage.getItem("hbd-scripts") !== "0"; }
    catch (e) { el.scriptToggle.checked = true; }
    el.scriptToggle.addEventListener("change", function () {
      try { localStorage.setItem("hbd-scripts", el.scriptToggle.checked ? "1" : "0"); } catch (e) {}
      if (lastDoc && state.mode === "view") renderHtml(lastDoc.text);
    });
    el.widthBtn.addEventListener("click", function () {
      var wide = !el.viewer.classList.contains("wide");
      el.viewer.classList.toggle("wide", wide);
      try { localStorage.setItem("hbd-wide", wide ? "1" : "0"); } catch (e) {}
    });
    el.fontMinus.addEventListener("click", function () { setReadScale(state.readScale - 10); });
    el.fontPlus.addEventListener("click", function () { setReadScale(state.readScale + 10); });
    el.sidebarToggle.addEventListener("click", toggleSidebar);
    el.sidebarScrim.addEventListener("click", function () { setSidebar(false); });
    el.modeSeg.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-mode]");
      if (b && !b.disabled) setMode(b.getAttribute("data-mode"));
    });

    try {
      if (localStorage.getItem("hbd-wide") === "1") el.viewer.classList.add("wide");
      var sc = parseInt(localStorage.getItem("hbd-scale"), 10);
      if (sc) { state.readScale = sc; document.documentElement.style.setProperty("--read-scale", sc / 100); }
    } catch (e) {}

    // 사이드바 초기 상태: 데스크톱 + 탐색 가능 스코프 + 로그인 이력 있으면 열기
    var wantSidebar = false;
    try { wantSidebar = localStorage.getItem("hbd-sidebar") !== "0"; } catch (e) {}
    if (CAN_BROWSE && wantSidebar && window.innerWidth > 900 && (getHint() || restoreToken())) setSidebar(true);
    if (!CAN_BROWSE) el.sidebarToggle.classList.add("hidden");

    // 로그인 상태 복원
    var saved = restoreToken();
    if (saved) {
      state.token = saved;
      onLoggedIn();
      scheduleRefresh();
    } else if (getHint()) {
      // 로그인한 적 있음 → 첫 상호작용 전에 조용히 연장 시도(차단되면 칩 표시)
      setTimeout(function () {
        if (!tokenValid()) requestToken().catch(function () { setNeedsLogin(true); });
      }, 800);
    }

    if (!HAS_OAUTH) el.loginBtn.title = "config.js 설정 필요";
    if (!HAS_API_KEY && !HAS_OAUTH) el.setupNote.classList.remove("hidden");

    // GIS 로드 대기
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if (window.google && google.accounts && google.accounts.oauth2) {
        initTokenClient();
        clearInterval(t);
      } else if (tries > 40) clearInterval(t);
    }, 250);

    // #f=<id> 해시로 파일 복원(새로고침·홈 화면 바로가기)
    var m = location.hash.match(/#f=([a-zA-Z0-9_-]{10,})/);
    if (m) {
      if (tokenValid() || HAS_API_KEY) loadFile(m[1]);
      else if (getHint()) pendingFileId = m[1]; // 조용한 로그인 후 열림
    }
  }

  // ---- 공유 네임스페이스 (browser.js / editor.js 에서 사용) ---------------
  window.HBD = {
    cfg: CFG,
    state: state,
    CAN_BROWSE: CAN_BROWSE,
    CAN_WRITE: CAN_WRITE,
    el: el,
    AppError: AppError,
    apiFetch: apiFetch,
    ensureToken: ensureToken,
    handleApiResponse: handleApiResponse,
    loadFile: loadFile,
    saveDriveFile: saveDriveFile,
    getFileVersion: getFileVersion,
    render: render,
    renderHtml: renderHtml,
    renderMarkdown: renderMarkdown,
    detectType: detectType,
    updateModeSeg: updateModeSeg,
    showBanner: showBanner,
    hideBanner: hideBanner,
    setSidebar: setSidebar,
    login: login,
    openPicker: openPicker,
    parseFileId: parseFileId,
  };
  // 테스트 훅(로컬 검증용)
  window.__hbd = window.HBD;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

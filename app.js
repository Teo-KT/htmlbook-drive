/* ==========================================================================
   htmlbook-drive — 애플리케이션 로직
   - 공유 링크(붙여넣기) 모드: API 키로 공개 파일 열람
   - 로그인 모드: Google OAuth(GIS) + Picker(drive.file)로 내 파일 열람
   서버 없이 브라우저에서만 동작.
   ========================================================================== */
(function () {
  "use strict";

  var CFG = window.HTMLBOOK_DRIVE_CONFIG || {};
  // 기본은 drive.file(선택한 파일만). READONLY_SCOPE 를 켜면 내 모든 파일을
  // 링크 붙여넣기로도 열 수 있다(개인용 · 테스트 사용자 전제, config.js 참고).
  var SCOPE = CFG.READONLY_SCOPE === true
    ? "https://www.googleapis.com/auth/drive.readonly"
    : "https://www.googleapis.com/auth/drive.file";

  // ---- 설정값 유효성 (placeholder 여부) -----------------------------------
  function isSet(v) {
    return typeof v === "string" && v.length > 0 && v.indexOf("YOUR_") === -1;
  }
  var HAS_API_KEY = isSet(CFG.API_KEY);
  var HAS_OAUTH = isSet(CFG.CLIENT_ID) && isSet(CFG.APP_ID);

  // ---- DOM 참조 -----------------------------------------------------------
  var el = {
    linkInput: document.getElementById("link-input"),
    openLinkBtn: document.getElementById("open-link"),
    loginBtn: document.getElementById("login-btn"),
    pickBtn: document.getElementById("pick-btn"),
    themeBtn: document.getElementById("theme-btn"),
    scriptToggle: document.getElementById("script-toggle"),
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
  };

  // 현재 접근 토큰(로그인 시)
  var accessToken = null;
  var tokenClient = null;
  var pickerApiLoaded = false;
  // 마지막으로 연 문서(스크립트 토글 재렌더용)
  var lastDoc = null;

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
  // 지원 형태:
  //   https://drive.google.com/file/d/<ID>/view
  //   https://drive.google.com/open?id=<ID>
  //   https://drive.google.com/uc?id=<ID>&export=download
  //   https://docs.google.com/document/d/<ID>/edit
  //   <ID> 자체(문자열)
  function parseFileId(raw) {
    if (!raw) return null;
    var s = String(raw).trim();
    // /d/<ID>
    var m = s.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
    if (m) return m[1];
    // id=<ID>
    m = s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
    if (m) return m[1];
    // 순수 ID (URL 아님)
    if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
    return null;
  }

  // ---- Drive 파일 가져오기 ------------------------------------------------
  // token 이 있으면 Bearer, 없으면 API 키 사용.
  function fetchDriveFile(id, token) {
    var keyQ = token ? "" : ("&key=" + encodeURIComponent(CFG.API_KEY));
    var headers = token ? { Authorization: "Bearer " + token } : {};
    var base = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id);

    var meta = null;
    return fetch(base + "?fields=name,mimeType,size,capabilities" + keyQ, { headers: headers })
      .then(function (r) { return handleApiResponse(r, token); })
      .then(function (m) {
        meta = m;
        if (m.mimeType && m.mimeType.indexOf("application/vnd.google-apps") === 0) {
          throw new AppError(
            "이 파일은 <b>구글 문서/시트/슬라이드</b> 형식입니다. 이 뷰어는 업로드된 " +
            "<b>HTML/Markdown 파일</b>만 지원합니다. (구글 문서는 드라이브에서 " +
            "<code>파일 → 다운로드 → 웹페이지(.html)</code> 로 내보낸 뒤 사용하세요.)"
          );
        }
        return fetch(base + "?alt=media" + keyQ, { headers: headers });
      })
      .then(function (r) { return handleMediaResponse(r); })
      .then(function (text) {
        return { id: id, name: meta.name || "(제목 없음)", mimeType: meta.mimeType || "", text: text };
      });
  }

  function AppError(msg) { this.name = "AppError"; this.message = msg; }
  AppError.prototype = Object.create(Error.prototype);

  function handleApiResponse(r, hadToken) {
    if (r.ok) return r.json();
    return r.text().then(function () {
      if (r.status === 404) {
        throw new AppError(
          "파일을 찾을 수 없습니다(404). 링크가 올바른지, 그리고 " +
          (hadToken
            ? "선택한 파일에 접근 권한이 있는지"
            : "파일이 <b>‘링크가 있는 모든 사용자’</b>로 공유되어 있는지") +
          " 확인하세요."
        );
      }
      if (r.status === 403 || r.status === 401) {
        throw new AppError(
          hadToken
            ? "접근이 거부되었습니다(" + r.status + "). 이 파일을 열 권한이 없거나 로그인이 만료되었습니다. 다시 로그인해 보세요."
            : "비공개 파일이거나 접근이 거부되었습니다(" + r.status + ").<br>" +
              "공유 링크 방식은 <b>‘링크가 있는 모든 사용자’</b>로 공유된 파일만 열 수 있습니다. " +
              "비공개 파일은 상단의 <b>구글 로그인 → 드라이브에서 열기</b> 를 사용하세요."
        );
      }
      throw new AppError("드라이브 요청 실패 (" + r.status + ").");
    });
  }

  function handleMediaResponse(r) {
    if (!r.ok) return handleApiResponse(r, !!accessToken);
    return r.text();
  }

  // ---- 포맷 판별 ----------------------------------------------------------
  function detectType(name, mimeType, text) {
    var n = (name || "").toLowerCase();
    var mt = (mimeType || "").toLowerCase();
    if (mt === "text/html" || /\.(html?|xhtml)$/.test(n)) return "html";
    if (mt === "text/markdown" || mt === "text/x-markdown" || /\.(md|markdown|mdown|mkd)$/.test(n)) return "md";
    // 스니핑: 앞부분에 html 태그가 있으면 html
    var head = (text || "").slice(0, 800).toLowerCase();
    if (head.indexOf("<!doctype html") !== -1 || /<html[\s>]/.test(head) || /<body[\s>]/.test(head)) return "html";
    // 그 외 텍스트는 마크다운으로 취급
    return "md";
  }

  // ---- 렌더링 -------------------------------------------------------------
  function render(doc) {
    lastDoc = doc;
    var type = detectType(doc.name, doc.mimeType, doc.text);

    el.docName.textContent = doc.name;
    el.docKind.textContent = type === "html" ? "HTML" : "Markdown";

    hideBanner();
    showHero(false);
    setLoading(false);
    showViewer(true);

    if (type === "html") {
      renderHtml(doc.text);
      el.htmlFrame.classList.remove("hidden");
      el.mdBody.classList.add("hidden");
      el.scriptToggle.parentElement.classList.remove("hidden");
    } else {
      renderMarkdown(doc.text);
      el.mdBody.classList.remove("hidden");
      el.htmlFrame.classList.add("hidden");
      el.scriptToggle.parentElement.classList.add("hidden");
    }
    // 문서 상단으로 스크롤
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderHtml(htmlText) {
    var allowScripts = el.scriptToggle.checked;
    // sandbox: 기본은 스크립트 차단(HTML/CSS는 그대로 렌더). 토글 시 스크립트 허용.
    // allow-same-origin 과 allow-scripts 를 동시에 주지 않는다(보안).
    var sandbox = allowScripts
      ? "allow-scripts allow-popups allow-forms allow-modals"
      : "allow-popups allow-forms";
    el.htmlFrame.setAttribute("sandbox", sandbox);
    // 새 창 링크가 부모를 덮지 않도록 <base target="_blank"> 주입
    var injected = htmlText;
    if (!/<base\b/i.test(injected)) {
      injected = injected.replace(/<head([^>]*)>/i, '<head$1><base target="_blank">');
      if (injected === htmlText) {
        injected = '<base target="_blank">' + htmlText;
      }
    }
    el.htmlFrame.srcdoc = injected;
  }

  function renderMarkdown(mdText) {
    var rawHtml = window.marked.parse(mdText, { gfm: true, breaks: false });
    var clean = window.DOMPurify.sanitize(rawHtml, {
      ADD_ATTR: ["target"],
    });
    el.mdBody.innerHTML = clean;
    // 링크는 새 탭에서 열기
    var links = el.mdBody.querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i++) {
      links[i].setAttribute("target", "_blank");
      links[i].setAttribute("rel", "noopener noreferrer");
    }
  }

  // ---- 공유 링크 열기 -----------------------------------------------------
  function openFromLink() {
    var id = parseFileId(el.linkInput.value);
    if (!id) {
      showBanner("드라이브 링크를 인식하지 못했습니다. 파일의 <b>공유 링크</b> 또는 파일 ID를 붙여넣어 주세요.", true);
      return;
    }
    if (!HAS_API_KEY && !accessToken) {
      showBanner(
        "공유 링크로 열려면 <code>config.js</code> 에 <b>API 키</b>가 필요합니다. " +
        "또는 상단의 <b>구글 로그인</b> 후 <b>드라이브에서 열기</b>를 사용하세요.", true);
      return;
    }
    setLoading(true);
    showHero(false);
    showViewer(false);
    hideBanner();
    // 로그인되어 있으면 토큰 우선(비공개 파일도 가능), 아니면 API 키
    fetchDriveFile(id, accessToken)
      .then(render)
      .catch(function (e) {
        setLoading(false);
        showViewer(false);
        showHero(true);
        showBanner((e && e.message) || "파일을 여는 중 오류가 발생했습니다.", true);
      });
  }

  // ---- 구글 로그인 (GIS) --------------------------------------------------
  function initTokenClient() {
    if (tokenClient || !window.google || !google.accounts || !google.accounts.oauth2) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.CLIENT_ID,
      scope: SCOPE,
      callback: function (resp) {
        if (resp && resp.access_token) {
          accessToken = resp.access_token;
          el.loginBtn.textContent = "로그인됨 ✓";
          el.pickBtn.disabled = false;
          hideBanner();
          openPicker(); // 로그인 직후 바로 선택창
        } else {
          showBanner("로그인에 실패했습니다. 다시 시도해 주세요.", true);
        }
      },
      error_callback: function (err) {
        showBanner("로그인이 취소되었거나 실패했습니다." + (err && err.type ? " (" + err.type + ")" : ""), true);
      },
    });
  }

  function login() {
    if (!HAS_OAUTH) { showSetupNeeded(); return; }
    initTokenClient();
    if (!tokenClient) {
      showBanner("구글 로그인 라이브러리를 아직 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.", true);
      return;
    }
    tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
  }

  // ---- Google Picker ------------------------------------------------------
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
    if (!accessToken) { login(); return; }
    ensurePicker().then(function () {
      var view = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setMimeTypes("text/html,text/markdown,text/x-markdown,text/plain,application/octet-stream")
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false)
        .setMode(google.picker.DocsViewMode.LIST);
      var picker = new google.picker.PickerBuilder()
        .setAppId(CFG.APP_ID)
        .setOAuthToken(accessToken)
        .setDeveloperKey(CFG.API_KEY)
        .addView(view)
        .setTitle("HTML / Markdown 파일 선택")
        .setCallback(pickerCallback)
        .build();
      picker.setVisible(true);
    }).catch(function (e) {
      showBanner((e && e.message) || "파일 선택창을 열지 못했습니다.", true);
    });
  }

  function pickerCallback(data) {
    if (!data || data.action !== google.picker.Action.PICKED) return;
    var f = data.docs && data.docs[0];
    if (!f) return;
    setLoading(true);
    showHero(false);
    showViewer(false);
    hideBanner();
    fetchDriveFile(f.id, accessToken)
      .then(render)
      .catch(function (e) {
        setLoading(false);
        showHero(true);
        showBanner((e && e.message) || "파일을 여는 중 오류가 발생했습니다.", true);
      });
  }

  // ---- 데모 (자격증명 없이 스타일 확인) -----------------------------------
  var DEMO_MD = [
    "# htmlbook-drive 데모",
    "",
    "이건 **Markdown** 파일이 어떻게 보이는지 보여주는 데모입니다. 구글 드라이브의",
    "`.md` 파일을 열면 이렇게 읽기 좋은 형태로 렌더링됩니다.",
    "",
    "## 주요 기능",
    "",
    "- 구글 **로그인**으로 내 비공개 파일 열람 (`drive.file` 범위)",
    "- **공유 링크** 붙여넣기로 공개 파일 열람",
    "- HTML · Markdown 두 포맷 지원",
    "",
    "> 파일의 공개 여부는 전적으로 구글 드라이브의 공유 설정이 결정합니다.",
    "> 이 뷰어는 그 권한을 우회하지 않습니다.",
    "",
    "### 코드 블록",
    "",
    "```js",
    "function hello(name) {",
    "  return `안녕하세요, ${name}!`;",
    "}",
    "```",
    "",
    "### 표",
    "",
    "| 방식 | 로그인 | 열람 가능 파일 |",
    "|------|:------:|----------------|",
    "| 공유 링크 | 불필요 | ‘링크가 있는 모든 사용자’ 공개 파일 |",
    "| 구글 로그인 | 필요 | 내가 선택한 내 파일(비공개 포함) |",
    "",
    "본문 링크는 [새 탭에서 열립니다](https://github.com).",
    "",
  ].join("\n");

  var DEMO_HTML = [
    "<!doctype html><html lang='ko'><head><meta charset='utf-8'>",
    "<style>",
    "  body{font-family:Georgia,serif;max-width:640px;margin:40px auto;padding:0 20px;line-height:1.7;color:#222}",
    "  h1{font-family:system-ui,sans-serif;color:#2f6feb}",
    "  .box{background:#f2f4f7;border-left:4px solid #2f6feb;padding:12px 16px;border-radius:6px}",
    "  code{background:#eef;padding:2px 6px;border-radius:4px}",
    "</style></head><body>",
    "<h1>HTML 데모 문서</h1>",
    "<p>이건 <b>HTML 파일</b>이 <i>원본 서식 그대로</i> 렌더링되는 예시입니다. ",
    "인라인 <code>&lt;style&gt;</code> 이 그대로 적용됩니다.</p>",
    "<div class='box'>구글 드라이브의 자체 완결형 HTML 파일은 이렇게 완벽한 형태로 보입니다.</div>",
    "<ul><li>서식 보존</li><li>표 · 이미지 · 스타일 유지</li></ul>",
    "</body></html>",
  ].join("\n");

  function openDemo(kind) {
    render({
      id: "demo",
      name: kind === "html" ? "데모 문서.html" : "데모 문서.md",
      mimeType: kind === "html" ? "text/html" : "text/markdown",
      text: kind === "html" ? DEMO_HTML : DEMO_MD,
    });
  }

  // ---- 설정 필요 안내 -----------------------------------------------------
  function showSetupNeeded() {
    showBanner(
      "구글 연동을 사용하려면 <code>config.js</code> 에 <b>CLIENT_ID / API_KEY / APP_ID</b> 를 " +
      "먼저 설정해야 합니다. 설정 방법은 저장소의 <b>README</b> 를 참고하세요. " +
      "지금은 아래 <b>데모</b> 로 화면을 미리 볼 수 있습니다.", true);
  }

  // ---- 테마 토글 ----------------------------------------------------------
  function toggleTheme() {
    var cur = document.documentElement.getAttribute("data-theme");
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var next;
    if (cur === "dark") next = "light";
    else if (cur === "light") next = "dark";
    else next = prefersDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("hbd-theme", next); } catch (e) {}
  }
  (function initTheme() {
    try {
      var saved = localStorage.getItem("hbd-theme");
      if (saved) document.documentElement.setAttribute("data-theme", saved);
    } catch (e) {}
  })();

  // ---- 초기 UI 설정 -------------------------------------------------------
  function init() {
    // 이벤트 바인딩
    el.openLinkBtn.addEventListener("click", openFromLink);
    el.linkInput.addEventListener("keydown", function (e) { if (e.key === "Enter") openFromLink(); });
    el.loginBtn.addEventListener("click", login);
    el.pickBtn.addEventListener("click", openPicker);
    el.themeBtn.addEventListener("click", toggleTheme);
    el.demoMd.addEventListener("click", function () { openDemo("md"); });
    el.demoHtml.addEventListener("click", function () { openDemo("html"); });
    el.scriptToggle.addEventListener("change", function () {
      if (lastDoc) renderHtml(lastDoc.text); // 토글 시 현재 HTML 재렌더
    });

    // 설정 상태에 따른 버튼 활성/비활성
    el.pickBtn.disabled = true; // 로그인 전엔 비활성
    if (!HAS_OAUTH) {
      el.loginBtn.disabled = false; // 눌러도 안내가 뜨도록 활성 유지
      el.loginBtn.title = "config.js 설정 필요";
    }
    if (!HAS_API_KEY && !HAS_OAUTH) {
      el.setupNote.classList.remove("hidden");
    }

    // GIS 준비되면 token client 초기화 시도(비동기 로드 대비)
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if (window.google && google.accounts && google.accounts.oauth2) {
        initTokenClient();
        clearInterval(t);
      } else if (tries > 40) {
        clearInterval(t);
      }
    }, 250);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // 테스트 훅(로컬 검증용) — 브라우저 콘솔/Playwright에서 접근
  window.__hbd = { parseFileId: parseFileId, detectType: detectType, renderMarkdown: renderMarkdown };
})();

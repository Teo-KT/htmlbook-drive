/* ==========================================================================
   htmlbook-drive — 편집 + 자동 저장
   모드:
   - inline(본문 편집, HTML): 렌더된 화면에서 텍스트 블록을 탭해 바로 수정.
     수정분은 소스에 "정밀 텍스트 패치"로 반영(스크립트·스타일 보존).
     htmlbook.io 의 tap-to-edit 방식을 벤치마킹. 편집 중 문서 스크립트는 꺼진다.
   - source(소스 편집, HTML·MD): CodeMirror + 실시간 미리보기 분할 화면.
   저장: 입력이 멈추고 2.5초 뒤 드라이브에 자동 저장(PATCH media).
         Cmd/Ctrl+S 즉시 저장. 버전 충돌은 저장 전에 감지해 알린다.
   ========================================================================== */
(function () {
  "use strict";
  var H = window.HBD;
  if (!H) return;

  var el = H.el;
  var chip = el.saveChip;
  var editorWrap = document.getElementById("editor-wrap");
  var cmHost = document.getElementById("cm-host");
  var cm = null;
  var suppressCm = false;

  // 인라인 편집용 소스 DOM 미러
  var srcDom = null;
  var srcAll = null;     // 원본 파싱 트리의 전체 요소 스냅샷(문서 순서)
  var srcHasDoctype = false;

  // ---- 저장 상태 머신 -----------------------------------------------------
  var save = {
    dirty: false,
    saving: false,
    queued: false,
    timer: null,
    lastError: null,
    conflict: false,
  };
  var AUTOSAVE_MS = 2500;

  function canSave() {
    var d = H.state.doc;
    return !!(d && d.id !== "demo" && d.canEdit && H.CAN_WRITE);
  }

  function setChip(kind, text) {
    chip.className = "chip save-chip " + kind;
    chip.textContent = text;
    chip.classList.remove("hidden");
  }
  function hideChip() { chip.classList.add("hidden"); }

  function markDirty(newText) {
    var d = H.state.doc;
    if (!d) return;
    d.text = newText;
    if (!canSave()) return;
    save.dirty = true;
    if (!save.conflict) setChip("dirty", "● 수정됨");
    if (save.timer) clearTimeout(save.timer);
    save.timer = setTimeout(function () { doSave(); }, AUTOSAVE_MS);
  }

  function doSave(opts) {
    opts = opts || {};
    var d = H.state.doc;
    if (!canSave() || !save.dirty || save.conflict) return Promise.resolve();
    if (save.saving) { save.queued = true; return Promise.resolve(); }
    if (save.timer) { clearTimeout(save.timer); save.timer = null; }
    save.saving = true;
    save.dirty = false;
    var textAtSave = d.text;
    setChip("saving", "저장 중…");

    // 저장 전 버전 확인: 다른 곳에서 파일이 바뀌었으면 덮어쓰지 않는다
    var pre = opts.skipVersionCheck || !d.version
      ? Promise.resolve(null)
      : H.getFileVersion(d.id).then(function (m) {
          if (d.version && m.version && String(m.version) !== String(d.version)) {
            var err = new H.AppError("conflict");
            err.isConflict = true;
            err.serverVersion = m.version;
            throw err;
          }
          return m;
        });

    return pre
      .then(function () {
        return H.saveDriveFile(d.id, textAtSave, d.mimeType, { keepalive: !!opts.keepalive });
      })
      .then(function (resp) {
        save.saving = false;
        save.lastError = null;
        if (resp && resp.version) d.version = resp.version;
        var t = new Date();
        var hh = String(t.getHours()).padStart(2, "0");
        var mm = String(t.getMinutes()).padStart(2, "0");
        setChip("saved", "✓ 저장됨 " + hh + ":" + mm);
        if (save.queued || save.dirty) {
          save.queued = false;
          save.dirty = true;
          save.timer = setTimeout(function () { doSave(); }, 400);
        }
      })
      .catch(function (e) {
        save.saving = false;
        save.dirty = true; // 아직 반영 안 됨
        if (e && e.isConflict) {
          save.conflict = true;
          setChip("error", "⚠ 다른 곳에서 수정됨");
          showConflictBanner(e.serverVersion);
        } else {
          save.lastError = e;
          setChip("error", "⚠ 저장 실패 — 눌러서 재시도");
        }
      });
  }

  function showConflictBanner(serverVersion) {
    H.showBanner(
      "이 파일이 <b>다른 곳에서 수정</b>되었습니다. 자동 저장을 멈췄습니다. " +
      '<button id="cf-overwrite" class="mini danger">내 내용으로 덮어쓰기</button> ' +
      '<button id="cf-reload" class="mini">드라이브 버전 다시 열기</button>', true);
    var ow = document.getElementById("cf-overwrite");
    var rl = document.getElementById("cf-reload");
    if (ow) ow.addEventListener("click", function () {
      H.hideBanner();
      save.conflict = false;
      H.state.doc.version = serverVersion; // 서버 버전 위에 덮어쓴다
      save.dirty = true;
      doSave({ skipVersionCheck: true });
    });
    if (rl) rl.addEventListener("click", function () {
      save.conflict = false;
      save.dirty = false;
      H.hideBanner();
      H.loadFile(H.state.doc.id);
    });
  }

  chip.addEventListener("click", function () {
    if (save.conflict) return;
    save.dirty = true;
    doSave();
  });

  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      if (H.state.mode !== "view" || save.dirty) {
        e.preventDefault();
        if (cm && H.state.mode === "source") markDirty(cm.getValue());
        doSave();
      }
    }
  });

  // 탭 이탈·창 닫기 직전에 미저장분을 최대한 밀어넣는다
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden" && save.dirty && !save.conflict) {
      doSave({ keepalive: true, skipVersionCheck: true });
    }
  });
  window.addEventListener("beforeunload", function (e) {
    if (save.dirty || save.saving) {
      if (save.dirty && !save.conflict) doSave({ keepalive: true, skipVersionCheck: true });
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ==========================================================================
  // 인라인(본문) 편집 — HTML 전용
  // ==========================================================================
  var BLOCK_SEL = "h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,figcaption,dt,dd,caption,summary,pre";
  var INLINE_TAGS = { B: 1, I: 1, EM: 1, STRONG: 1, CODE: 1, SPAN: 1, A: 1, BR: 1, SMALL: 1, SUB: 1, SUP: 1, MARK: 1, U: 1, S: 1, KBD: 1, TIME: 1, ABBR: 1 };

  function isCandidate(elm) {
    if (elm.closest && elm.matches) {
      if (elm.matches(BLOCK_SEL)) return true;
    }
    var tag = elm.tagName;
    if (tag !== "DIV" && tag !== "SPAN") return false;
    if (!elm.textContent || !elm.textContent.trim()) return false;
    var kids = elm.children;
    for (var i = 0; i < kids.length; i++) {
      if (!INLINE_TAGS[kids[i].tagName]) return false;
    }
    return true;
  }

  // 후보이면서 후보 자손이 없는(가장 안쪽) 요소만 편집 대상으로 고른다.
  // 편집 대상끼리는 절대 중첩되지 않으므로 개별 패치가 서로를 깨뜨리지 않는다.
  function computeEditableIndices(dom) {
    var all = dom.querySelectorAll("*");
    var has = new Map(); // element -> 자기 서브트리에 후보가 있는지
    var editable = [];
    for (var i = all.length - 1; i >= 0; i--) {
      var e = all[i];
      var childHas = false;
      for (var c = 0; c < e.children.length; c++) {
        if (has.get(e.children[c])) { childHas = true; break; }
      }
      var cand = isCandidate(e);
      if (cand && !childHas) editable.push(i);
      has.set(e, cand || childHas);
    }
    return editable;
  }

  function serializeSrc() {
    var out = srcDom.documentElement.outerHTML;
    return srcHasDoctype ? "<!doctype html>\n" + out : out;
  }

  function countOnce(hay, needle) {
    if (!needle) return 0;
    var first = hay.indexOf(needle);
    if (first === -1) return 0;
    return hay.indexOf(needle, first + 1) === -1 ? 1 : 2;
  }

  // 핵심: 수정된 블록을 소스 문자열에 반영.
  // 1) 원래 innerHTML 이 소스에 딱 한 번 나타나면 그 부분만 정밀 치환(원본 서식 보존)
  // 2) 아니면 소스 DOM 미러에 반영 후 전체 직렬화(스크립트·스타일은 그대로 보존됨)
  function applyPatch(eid, newInner) {
    var srcEl = srcAll && srcAll[eid];
    if (!srcEl) return;
    var oldInner = srcEl.innerHTML;
    var text = H.state.doc.text;
    var newText;
    if (oldInner !== newInner && countOnce(text, oldInner) === 1) {
      var at = text.indexOf(oldInner);
      newText = text.slice(0, at) + newInner + text.slice(at + oldInner.length);
      srcEl.innerHTML = newInner;
    } else if (oldInner !== newInner) {
      srcEl.innerHTML = newInner;
      newText = serializeSrc();
    } else {
      return;
    }
    markDirty(newText);
  }

  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || d.hbd !== "edit") return;
    if (H.state.mode !== "inline") return;
    applyPatch(Number(d.eid), String(d.html));
  });

  var EDITOR_IFRAME_JS =
    "(function(){" +
    "var timers={};" +
    "function send(t){var id=t.getAttribute('data-hbd-eid');" +
    "parent.postMessage({hbd:'edit',eid:id,html:t.innerHTML},'*');}" +
    "var els=document.querySelectorAll('[data-hbd-eid]');" +
    "for(var i=0;i<els.length;i++){els[i].setAttribute('contenteditable','true');els[i].setAttribute('spellcheck','false');}" +
    "document.addEventListener('input',function(e){" +
    "var t=e.target&&e.target.closest?e.target.closest('[data-hbd-eid]'):null;if(!t)return;" +
    "var id=t.getAttribute('data-hbd-eid');" +
    "if(timers[id])clearTimeout(timers[id]);" +
    "timers[id]=setTimeout(function(){send(t);},450);},false);" +
    "document.addEventListener('blur',function(e){" +
    "var t=e.target&&e.target.closest?e.target.closest('[data-hbd-eid]'):null;if(!t)return;" +
    "var id=t.getAttribute('data-hbd-eid');" +
    "if(timers[id]){clearTimeout(timers[id]);delete timers[id];}send(t);},true);" +
    "document.addEventListener('click',function(e){" +
    "var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;" +
    "if(a)e.preventDefault();},false);" +
    // 검증용 훅: 불투명 출처 iframe 에는 외부 합성 입력이 닿지 않으므로
    // 부모(우리 페이지)가 메시지로 편집 동작을 재현해 셀프테스트한다.
    "window.addEventListener('message',function(ev){var d=ev.data;if(!d)return;" +
    "if(d.hbd==='probe'){parent.postMessage({hbd:'probe-result'," +
    "count:document.querySelectorAll('[data-hbd-eid][contenteditable]').length},'*');}" +
    "if(d.hbd==='sim-edit'){var t=document.querySelector('[data-hbd-eid=\"'+d.eid+'\"]');" +
    "if(t){t.innerHTML=d.html;t.dispatchEvent(new Event('input',{bubbles:true}));}}});" +
    "})();";

  var EDITOR_IFRAME_CSS =
    "[data-hbd-eid]{cursor:text;transition:outline-color .12s;outline:1px dashed rgba(47,111,235,.0);outline-offset:2px;min-height:1em}" +
    "[data-hbd-eid]:hover{outline-color:rgba(47,111,235,.45)}" +
    "[data-hbd-eid]:focus{outline:2px solid rgba(47,111,235,.85);border-radius:2px}";

  function enterInline() {
    var d = H.state.doc;
    srcHasDoctype = /^\s*<!doctype/i.test(d.text);
    srcDom = new DOMParser().parseFromString(d.text, "text/html");
    srcAll = srcDom.querySelectorAll("*");
    var editable = computeEditableIndices(srcDom);

    // 같은 텍스트를 다시 파싱하면 트리가 동일하므로, 인덱스로 뷰 쪽에 eid 를 새긴다
    var viewDom = new DOMParser().parseFromString(d.text, "text/html");
    var viewAll = viewDom.querySelectorAll("*");
    for (var i = 0; i < editable.length; i++) {
      var idx = editable[i];
      if (viewAll[idx]) viewAll[idx].setAttribute("data-hbd-eid", String(idx));
    }
    var decorated = (srcHasDoctype ? "<!doctype html>\n" : "") + viewDom.documentElement.outerHTML;

    H.renderHtml(decorated, {
      stripScripts: true,
      sandbox: "allow-scripts",
      decorate: function (doc) {
        var st = doc.createElement("style");
        st.textContent = EDITOR_IFRAME_CSS;
        (doc.head || doc.documentElement).appendChild(st);
        var sc = doc.createElement("script");
        sc.textContent = EDITOR_IFRAME_JS;
        (doc.body || doc.documentElement).appendChild(sc);
      },
    });
    el.htmlFrame.classList.remove("hidden");
    el.mdBody.classList.add("hidden");
    H.showBanner("본문 편집: 텍스트를 <b>탭(클릭)해서 바로 수정</b>하세요. 멈추면 자동 저장됩니다. " +
      "편집 중에는 문서 스크립트가 잠시 꺼집니다. 구조·코드를 고치려면 <b>소스</b> 모드를 사용하세요.");
  }

  function exitInline() {
    srcDom = null; srcAll = null;
    H.hideBanner();
  }

  // ==========================================================================
  // 소스 편집 — CodeMirror + 실시간 미리보기
  // ==========================================================================
  var previewTimer = null;

  function ensureCm(mode) {
    if (!window.CodeMirror) return null;
    if (!cm) {
      cm = CodeMirror(cmHost, {
        value: "",
        lineNumbers: true,
        lineWrapping: true,
        viewportMargin: 30,
        extraKeys: { "Enter": "newlineAndIndentContinueMarkdownList" },
      });
      cm.on("change", function () {
        if (suppressCm) return;
        var text = cm.getValue();
        markDirty(text);
        schedulePreview(text);
      });
    }
    cm.setOption("mode", mode);
    return cm;
  }

  function schedulePreview(text) {
    var d = H.state.doc;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      if (H.state.mode !== "source") return;
      if (d.type === "md") {
        var pane = el.mdBody;
        var st = pane.scrollTop;
        H.renderMarkdown(text);
        pane.scrollTop = st;
      } else {
        // 스크롤 유지: 스크립트 꺼진 미리보기는 same-origin 이라 접근 가능
        var st2 = 0;
        try { st2 = el.htmlFrame.contentDocument.scrollingElement.scrollTop; } catch (e) {}
        var restore = function () {
          try { el.htmlFrame.contentDocument.scrollingElement.scrollTop = st2; } catch (e) {}
          el.htmlFrame.removeEventListener("load", restore);
        };
        el.htmlFrame.addEventListener("load", restore);
        H.renderHtml(text, { stripScripts: true, sandbox: "allow-popups allow-same-origin" });
      }
    }, d.type === "md" ? 350 : 800);
  }

  function enterSource() {
    var d = H.state.doc;
    document.body.classList.add("split-edit");
    document.body.classList.add("html-mode"); // 분할 화면은 항상 전체 높이 레이아웃
    editorWrap.classList.remove("hidden");
    var mode = d.type === "md" ? "markdown" : "htmlmixed";
    var c = ensureCm(mode);
    if (!c) {
      H.showBanner("코드 편집기를 불러오지 못했습니다. 새로고침해 보세요.", true);
      return;
    }
    suppressCm = true;
    c.setValue(d.text);
    suppressCm = false;
    // 미리보기 초기화
    if (d.type === "md") {
      H.renderMarkdown(d.text);
      el.mdBody.classList.remove("hidden");
      el.htmlFrame.classList.add("hidden");
    } else {
      H.renderHtml(d.text, { stripScripts: true, sandbox: "allow-popups allow-same-origin" });
      el.htmlFrame.classList.remove("hidden");
      el.mdBody.classList.add("hidden");
    }
    setTimeout(function () { c.refresh(); c.focus(); }, 30);
  }

  function exitSource() {
    document.body.classList.remove("split-edit");
    editorWrap.classList.add("hidden");
    if (previewTimer) clearTimeout(previewTimer);
  }

  // ==========================================================================
  // 모드 전환
  // ==========================================================================
  function setMode(m) {
    var d = H.state.doc;
    if (!d) return;
    var prev = H.state.mode;
    if (prev === m) return;

    // 이전 모드 정리 (미저장분은 상태에 이미 반영되어 있음)
    if (prev === "inline") exitInline();
    if (prev === "source") {
      if (cm) { var t = cm.getValue(); if (t !== d.text) markDirty(t); }
      exitSource();
    }

    H.state.mode = m;
    if (m === "view") {
      H.render(d, { preview: true });
      H.hideBanner();
    } else if (m === "inline") {
      if (d.type !== "html") { H.state.mode = "view"; return; }
      enterInline();
    } else if (m === "source") {
      enterSource();
    }
  }

  function closeIfOpen() {
    if (save.dirty && !save.conflict) doSave({ skipVersionCheck: true });
    if (H.state.mode === "inline") exitInline();
    if (H.state.mode === "source") exitSource();
    H.state.mode = "view";
    save.dirty = false;
    save.conflict = false;
    if (save.timer) { clearTimeout(save.timer); save.timer = null; }
    hideChip();
  }

  H.editor = { setMode: setMode, closeIfOpen: closeIfOpen, markDirty: markDirty, doSave: doSave, applyPatch: applyPatch, computeEditableIndices: computeEditableIndices };
})();

# 📖 htmlbook-drive

**구글 드라이브에 있는 HTML · Markdown 파일을 웹페이지 형태로 완벽하게 보는 뷰어입니다.**

[htmlbook.io](https://htmlbook.io) 처럼 문서를 이쁘게 보여주되, 파일을 업로드할 필요 없이
**내 구글 드라이브의 파일을 그대로** 봅니다. 서버 없이 브라우저에서만 동작하는 정적 사이트입니다.

- 🔐 **구글 로그인 + 파일 선택창** — 내 **비공개** 파일도 공개하지 않고 선택해서 봅니다. (`drive.file` 권한 → 내가 고른 파일에만 접근)
- 🔗 **공유 링크 붙여넣기** — ‘링크가 있는 모든 사용자’로 공유된 파일을 링크만으로 봅니다.
- 📄 **HTML · Markdown** 두 포맷 지원.

> **프라이버시**: 이 페이지가 공개되어 있어도 **여러분의 파일이 공개되는 게 아닙니다.**
> 방문자에게는 빈 뷰어만 보입니다. 파일을 열려면 (1) 그 파일의 공유 링크를 알거나,
> (2) 로그인해서 접근 권한이 있어야 합니다. **파일 공개 여부는 전적으로 구글 드라이브의 공유
> 설정이 결정**하며, 이 뷰어는 그 권한을 우회하지 않습니다.

---

## 데모

`config.js` 설정 전이라도, 화면 하단의 **“Markdown 데모 보기 / HTML 데모 보기”** 버튼으로
렌더링 스타일을 미리 볼 수 있습니다.

---

## 설정 (한 번만)

구글 드라이브에 접근하려면 본인의 **Google Cloud 프로젝트**에서 아래를 만든 뒤,
`config.js` 에 값을 채워 넣습니다. (약 5~10분)

### 1. API 사용 설정
[Google Cloud Console](https://console.cloud.google.com/) 에서 프로젝트를 하나 선택(또는 생성)하고,
**API 및 서비스 → 라이브러리**에서 다음 두 개를 **사용 설정**합니다.
- **Google Drive API**
- **Google Picker API**

### 2. API 키 만들기
**API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → API 키**
- 만든 키를 눌러 **애플리케이션 제한 → HTTP 리퍼러(웹사이트)** 선택 후 아래를 추가:
  - `https://teo-kt.github.io/*`
  - `http://localhost:*` (로컬 테스트용)
- **API 제한**은 *Google Drive API* 와 *Google Picker API* 로 한정하는 것을 권장합니다.

> ⚠️ API 키는 이렇게 **리퍼러 제한**을 걸면 공개돼도 안전합니다. (그래서 `config.js` 를 커밋해도 됩니다.)

### 3. OAuth 클라이언트 ID 만들기
**사용자 인증 정보 만들기 → OAuth 클라이언트 ID → 애플리케이션 유형: 웹 애플리케이션**
- **승인된 자바스크립트 원본**에 다음을 추가:
  - `https://teo-kt.github.io`
  - `http://localhost:8000` (로컬 테스트용, 원하는 포트로)
- 리다이렉트 URI는 필요 없습니다(토큰 방식).

**OAuth 동의 화면**: 사용자 유형을 *외부*로 만들었다면, **테스트 사용자**에 본인 계정을 추가하세요.
이 앱은 `drive.file` 범위만 사용하므로 **민감/제한 범위가 아니어서 구글의 앱 심사가 필요 없습니다.**

### 4. `config.js` 채우기
```js
window.HTMLBOOK_DRIVE_CONFIG = {
  CLIENT_ID: "1234567890-xxxx.apps.googleusercontent.com", // OAuth 클라이언트 ID
  API_KEY:   "AIzaSy...",                                   // API 키(리퍼러 제한 필수)
  APP_ID:    "1234567890",                                  // GCP 프로젝트 번호(숫자)
};
```
- `APP_ID` = 프로젝트 번호입니다. Console **홈** 또는 **프로젝트 설정**의 “프로젝트 번호”에서 확인하세요.

---

## 사용법

1. 페이지를 엽니다.
2. **내 비공개 파일** → 상단 **구글 로그인** → **드라이브에서 열기** → 파일 선택창에서 HTML/MD 선택.
3. **공유된 파일** → 파일의 공유 링크를 복사해 상단 입력창에 붙여넣고 **열기**.
   - 이 방식은 파일이 **‘링크가 있는 모든 사용자’** 로 공유되어 있어야 합니다.
   - 비공개 파일이면 대신 로그인 방식을 쓰세요.

지원하는 링크 형태(자동 인식):
```
https://drive.google.com/file/d/<파일ID>/view
https://drive.google.com/open?id=<파일ID>
https://drive.google.com/uc?id=<파일ID>&export=download
<파일ID> 문자열 자체
```

---

## 로컬에서 실행

```bash
# 저장소 폴더에서
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000 접속
```
> `file://` 로 직접 열면 구글 로그인/일부 fetch가 막힙니다. 반드시 `http://localhost` 로 여세요.
> (OAuth 원본에 등록한 포트와 같아야 합니다.)

---

## 배포 (GitHub Pages)

이 저장소는 GitHub Pages로 바로 배포됩니다.
- **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `root`**
- 배포 URL: `https://teo-kt.github.io/htmlbook-drive/`
- 이 URL을 위 **API 키 리퍼러**와 **OAuth 승인된 자바스크립트 원본**에 등록해야 정상 동작합니다.

---

## 동작 방식 / 기술

| 구성 | 내용 |
|------|------|
| 형태 | 순수 클라이언트 사이드 정적 사이트(서버 없음) |
| 로그인 | Google Identity Services 토큰 방식, 범위 `drive.file` |
| 파일 선택 | Google Picker API |
| 파일 읽기 | Drive API v3 `files.get?alt=media` (토큰 또는 API 키) |
| Markdown | [marked](https://github.com/markedjs/marked) + [DOMPurify](https://github.com/cure53/DOMPurify) 살균 |
| HTML | 샌드박스 `<iframe srcdoc>` 로 원본 서식 그대로 렌더(기본 스크립트 차단, 토글로 허용) |

## 한계

- **구글 문서/시트/슬라이드**(`application/vnd.google-apps.*`)는 지원하지 않습니다. 업로드된 `.html` / `.md` 파일만 지원합니다.
- 외부 리소스(다른 곳에 있는 이미지 등)를 참조하는 HTML은 그 리소스 접근 권한에 따라 일부가 안 보일 수 있습니다. **자체 완결형(self-contained) HTML** 은 완벽하게 표시됩니다.
- OAuth·Picker는 구글이 호스팅하는 스크립트를 불러오므로 완전 오프라인은 아닙니다(뷰어 자체는 정적).

## 라이선스

MIT

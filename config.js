/*
 * htmlbook-drive 설정값
 * ---------------------------------------------------------------------------
 * 아래 세 값을 본인의 Google Cloud 프로젝트 값으로 채우세요.
 * (README.md 의 "설정" 섹션에 발급 방법이 자세히 나와 있습니다.)
 *
 * 이 값들은 "비밀"이 아닙니다.
 *   - OAuth 클라이언트 ID: 공개되어도 되는 값입니다(리다이렉트/원본 제한으로 보호됨).
 *   - API 키: 반드시 "HTTP 리퍼러 제한"을 걸어 두세요(그러면 공개되어도 안전).
 * 따라서 이 파일은 그대로 커밋해도 됩니다.
 *
 * 값을 비워 두면(placeholder 그대로면) 구글 연동 기능은 비활성화되고,
 * "데모 보기" 기능만 동작합니다.
 */
window.HTMLBOOK_DRIVE_CONFIG = {
  // OAuth 2.0 클라이언트 ID (웹 애플리케이션). 예: "1234567890-abc...apps.googleusercontent.com"
  CLIENT_ID: "YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com",

  // API 키 (HTTP 리퍼러 제한 필수). 예: "AIza..."
  API_KEY: "YOUR_API_KEY",

  // Google Picker 용 앱 ID = GCP 프로젝트 번호(숫자). 예: "1234567890"
  APP_ID: "YOUR_PROJECT_NUMBER",
};

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
  CLIENT_ID: "740491906618-cgr9tsnoo4rliagvd2mkmst6chau9tn7.apps.googleusercontent.com",

  // API 키 (HTTP 리퍼러 제한 필수). 예: "AIza..."
  API_KEY: "AIzaSyB9h7uqTFck6vK-DoYQshmNDBzHLRLeofw",

  // Google Picker 용 앱 ID = GCP 프로젝트 번호(숫자). 예: "1234567890"
  APP_ID: "740491906618",

  // (선택) 로그인 범위 확장. true 면 drive.file 대신 drive.readonly 로 로그인합니다.
  //   - 내 드라이브의 "모든" 파일을 Picker 선택 없이 링크 붙여넣기만으로 열 수 있습니다.
  //   - drive.readonly 는 제한(restricted) 범위라 앱을 일반 공개하려면 구글 심사가 필요하지만,
  //     OAuth 동의 화면이 "테스트" 상태이고 본인이 테스트 사용자면 심사 없이 쓸 수 있습니다.
  //     (로그인 시 "확인되지 않은 앱" 경고가 뜨면 "고급 → 이동"으로 계속하면 됩니다.)
  //   - false(기본): 최소 권한. Picker 로 선택한 파일에만 접근합니다.
  READONLY_SCOPE: true,
};

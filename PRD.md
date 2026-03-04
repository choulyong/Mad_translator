# 영화 파일 관리 대시보드 (Movie Renamer Dashboard) PRD

## 1. 프로젝트 개요
로컬 디렉토리의 영화 파일을 스캔하여 TMDB 메타데이터를 기반으로 파일명을 자동 변경하고, 정보를 로컬 데이터베이스에 아카이빙하는 개인용 관리 도구입니다.

## 2. 목표
- 복잡한 영화 파일명을 표준화된 형식 "한글 제목 (연도).확장자"로 정리.
- 로컬 DB에 영화 정보를 저장하여 개인 라이브러리 구축.
- 직관적인 웹 인터페이스(Next.js) 제공.

## 3. 핵심 기능 (Functional Requirements)

### 3.1 파일 스캔 (File Scanning)
- 사용자가 지정한 로컬 경로 입력 수락.
- 해당 경로 내의 비디오 파일(.mkv, .mp4, .avi) 식별.
- 하위 디렉토리 포함 여부 (옵션, 기본은 1 depth).

### 3.2 영화 식별 (Identify Movie)
- 파일명에서 노이즈 제거 후 제목/연도 추출 (예: `Inception.2010.1080p...` -> `Inception`, `2010`).
- TMDB API 검색:
    1. 한국어(`ko-KR`) 우선 검색.
    2. 결과 없으면 영어(`en-US`) 검색 후 구글 번역 API로 줄거리 번역.
- 검색 결과 신뢰도 확인 (사용자 수동 선택 가능 기능 고려, 초기엔 자동 매칭).

### 3.3 파일 이름 변경 (Rename)
- 변경 규칙: `{한국어 제목} ({개봉연도}).{확장자}`.
- 특수문자 등 파일명으로 사용할 수 없는 문자 처리.
- 중복 파일명 처리 (예: `(1)` 추가).
- 실제 파일 시스템 변경 (`fs.rename`).

### 3.4 라이브러리 관리 (Library Management)
- 변경된 파일 정보를 SQLite DB에 저장.
- 저장 정보: 원본 파일명, 변경된 파일명, TMDB ID, 포스터 경로, 줄거리, 개봉일.
- 대시보드에서 처리 이력 조회.

## 4. 비기능 요구사항 (Non-Functional Requirements)
- **성능**: 100개 이상의 파일도 UI 멈춤 없이 처리 (Server Actions + Streaming/Progress).
- **보안**: 로컬 실행이므로 인증은 생략하나, 파일 시스템 접근은 서버 사이드에서만 수행.
- **UI/UX**: 다크 모드 지원 (Shadcn/UI), 실시간 진행률 표시.

## 5. UI 구조
- **Sidebar**: 메뉴 (스캔, 라이브러리, 설정).
- **Main Area**:
    - **Scanner**: 경로 입력 -> 파일 리스트 -> 개별/일괄 처리 버튼.
    - **Library**: 저장된 영화 그리드/리스트 뷰.
- **Toaster**: 작업 성공/실패 알림.

## 6. 데이터 흐름
1. `User` -> `Scan Path` -> `Server Action (fs.readdir)` -> `UI List`
2. `User` -> `Extract Metadata` -> `Server Action (TMDB API)` -> `UI Preview`
3. `User` -> `Confirm Rename` -> `Server Action (fs.rename + DB Insert)` -> `UI Update`

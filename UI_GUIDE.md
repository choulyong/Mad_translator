# UI Guide - Movie Renamer Dashboard

## 1. 디자인 시스템

### 1.1 테마
- **기본 모드**: 다크 모드 (Shadcn/UI Zinc 팔레트)
- **배경**: `hsl(240, 10%, 3.9%)` (거의 검정에 가까운 딥 다크)
- **카드 배경**: `hsl(240, 10%, 6%)` (미세하게 밝은 다크)
- **보더**: `hsl(240, 5%, 14%)` (은은한 구분선)
- **액센트**: `hsl(142, 71%, 45%)` (에메랄드 그린 - 성공/주요 액션)
- **경고**: `hsl(0, 84%, 60%)` (레드 - 파괴적 액션/에러)
- **텍스트**: `hsl(0, 0%, 98%)` (거의 흰색)
- **뮤트 텍스트**: `hsl(240, 5%, 50%)` (회색 보조 텍스트)

### 1.2 타이포그래피
- **헤딩**: `font-bold tracking-tight`
- **페이지 제목**: 24px (`text-2xl`)
- **섹션 제목**: 18px (`text-lg`)
- **본문**: 14px (`text-sm`)
- **캡션/뱃지**: 12px (`text-xs`)
- **폰트**: 시스템 폰트 스택 (Pretendard 없이 기본 sans-serif)

### 1.3 간격 규칙
- **페이지 패딩**: `p-6`
- **카드 내부 패딩**: `p-4`
- **컴포넌트 간 간격**: `gap-4` (16px)
- **섹션 간 간격**: `gap-6` (24px)
- **인라인 요소 간격**: `gap-2` (8px)

### 1.4 모서리 둥글기
- **카드/다이얼로그**: `rounded-lg` (8px)
- **버튼**: `rounded-md` (6px)
- **뱃지/태그**: `rounded-full`
- **인풋**: `rounded-md` (6px)

---

## 2. 전체 레이아웃

```
+----------------------------------------------------------+
|  [Sidebar 56px]  |         Main Content Area              |
|                  |                                        |
|   (Film icon)    |   [Page Title]                         |
|   Movie          |   [Page Description]                   |
|   Renamer        |                                        |
|                  |   +----------------------------------+ |
|   -----          |   |                                  | |
|                  |   |        Page Content               | |
|   [Scan icon]    |   |                                  | |
|   Scanner        |   |                                  | |
|                  |   |                                  | |
|   [Grid icon]    |   |                                  | |
|   Library        |   |                                  | |
|                  |   |                                  | |
|   [Gear icon]    |   |                                  | |
|   Settings       |   |                                  | |
|                  |   +----------------------------------+ |
|                  |                                        |
|                  |                          [Toaster]     |
+----------------------------------------------------------+
```

### 2.1 사이드바 (Sidebar)
- **너비**: 접힌 상태 `w-14` (56px) / 펼친 상태 `w-56` (224px)
- **위치**: 왼쪽 고정 (`fixed left-0`)
- **높이**: 전체 뷰포트 (`h-screen`)
- **배경**: 메인보다 약간 어둡게 (`bg-card`)
- **보더**: 오른쪽 보더 (`border-r`)

#### 사이드바 구성요소
```
+----------------+
|  [Film icon]   |   <- 로고 영역 (h-14, border-b)
|  Movie Renamer |      펼친 상태에서만 텍스트 표시
+----------------+
|                |
|  [Scan]        |   <- nav item (active: bg-accent/10, text-accent)
|  Scanner       |
|                |
|  [Library]     |   <- nav item (hover: bg-muted)
|  Library       |
|                |
|  [Settings]    |   <- nav item
|  Settings      |
|                |
+----------------+
|  [ChevronL/R]  |   <- 접기/펼치기 토글 버튼 (하단 고정)
+----------------+
```

#### 네비게이션 아이템
- **아이콘**: Lucide React (`ScanSearch`, `LayoutGrid`, `Settings`)
- **활성 상태**: 좌측 2px 액센트 바 + 배경 `bg-accent/10` + 텍스트 `text-accent`
- **호버**: `bg-muted/50`
- **접힌 상태**: 아이콘만 표시, 호버 시 tooltip으로 메뉴명

### 2.2 메인 컨텐츠 영역
- **마진**: 사이드바 너비만큼 좌측 마진 (`ml-14` 또는 `ml-56`)
- **패딩**: `p-6`
- **최대 너비**: `max-w-7xl mx-auto` (큰 모니터에서 중앙 정렬)
- **오버플로우**: `overflow-y-auto h-screen`

### 2.3 Toaster (알림)
- **위치**: 우하단 (`bottom-right`)
- **라이브러리**: Sonner (Shadcn 통합)
- **유형**:
  - `success`: 초록 아이콘 - "파일 이름 변경 완료"
  - `error`: 빨간 아이콘 - "경로를 찾을 수 없습니다"
  - `info`: 파란 아이콘 - "TMDB 검색 중..."
- **지속 시간**: 4초 (에러는 6초)

---

## 3. Scanner 페이지 (`/`)

메인 페이지. 영화 파일 스캔, 식별, 이름 변경의 전체 워크플로우가 이루어지는 핵심 페이지.

### 3.1 페이지 헤더
```
Scanner                              [Identify All] [Rename All]
Scan a directory to find and rename   ← 파일이 있을 때만 표시
movie files automatically.
```
- **제목**: "Scanner" (`text-2xl font-bold`)
- **설명**: 뮤트 텍스트 (`text-muted-foreground`)
- **일괄 액션 버튼**: 우상단, 파일 목록이 있을 때만 표시

### 3.2 경로 입력 섹션 (FileScanner)
```
+----------------------------------------------------------+
|  [Card]                                                   |
|                                                           |
|  Directory Path                                           |
|  +----------------------------------------------+ [Scan] |
|  | D:\Movies                                     |        |
|  +----------------------------------------------+        |
|                                                           |
|  Supported formats: .mkv, .mp4, .avi                      |
+----------------------------------------------------------+
```

- **카드**: `bg-card border rounded-lg p-4`
- **라벨**: "Directory Path" (`text-sm font-medium`)
- **인풋**: 전체 너비, 플레이스홀더 `Enter folder path (e.g., D:\Movies)`
- **Scan 버튼**:
  - 기본: `variant="default"` (accent 컬러)
  - 아이콘: `ScanSearch` (16px, 버튼 좌측)
  - 스캔 중: 스피너 아이콘 + "Scanning..." 텍스트, 버튼 비활성화
- **보조 텍스트**: "Supported formats: .mkv, .mp4, .avi" (`text-xs text-muted-foreground`)

### 3.3 일괄 액션 바 (BatchActions)
```
+----------------------------------------------------------+
|  12 files found                   [Identify All] [Rename All] |
+----------------------------------------------------------+
```

- **조건**: 파일 목록이 1개 이상일 때만 표시
- **좌측**: 파일 수 카운트 (`text-sm text-muted-foreground`)
- **Identify All 버튼**:
  - `variant="outline"` (테두리만)
  - 아이콘: `Sparkles`
  - 식별 중: 프로그레스 텍스트 "Identifying 3/12..."
  - 조건: `idle` 상태 파일이 1개 이상
- **Rename All 버튼**:
  - `variant="default"` (accent 채움)
  - 아이콘: `PenLine`
  - 처리 중: 프로그레스 텍스트 "Renaming 5/12..."
  - 조건: `ready` 상태 파일이 1개 이상

### 3.4 파일 목록 테이블 (FileList + FileRow)

#### 테이블 헤더
```
+------+--------------------+---------------------+--------+--------+---------+
| #    | Original Filename  | Matched Result      | Size   | Status | Actions |
+------+--------------------+---------------------+--------+--------+---------+
```

- **컨테이너**: `ScrollArea` (최대 높이 `max-h-[calc(100vh-320px)]`)
- **테이블**: Shadcn Table 컴포넌트
- **열 너비 비율**: `#` 48px | `Original` 30% | `Matched` 35% | `Size` 80px | `Status` 100px | `Actions` 160px

#### 파일 행 (FileRow) - 상태별 UI

##### 상태: `idle` (스캔 직후)
```
| 1 | Inception.2010.1080p.mkv    | —                  | 2.1 GB | [Idle]   | [Identify] |
```
- **번호**: `text-muted-foreground text-xs`
- **원본 파일명**: `font-mono text-sm` (코드 폰트로 파일명 느낌)
- **매칭 결과**: em dash `—` (`text-muted-foreground`)
- **사이즈**: `text-muted-foreground text-xs`
- **Status 뱃지**: `variant="secondary"` 회색 "Idle"
- **액션**: [Identify] 버튼 `variant="ghost" size="sm"`

##### 상태: `identifying` (TMDB 검색 중)
```
| 1 | Inception.2010.1080p.mkv    | [Skeleton]         | 2.1 GB | [...]    | [disabled] |
```
- **매칭 결과**: Skeleton 애니메이션 (pulse)
- **Status**: 스피너 아이콘 회전
- **액션 버튼**: 비활성화

##### 상태: `ready` (매칭 완료, 이름 변경 대기)
```
| 1 | Inception.2010.1080p.mkv    | [Poster] 인셉션    | 2.1 GB | [Ready]  | [Rename]   |
|   |                              | (2010)             |        |          |            |
```
- **매칭 결과 영역**:
  ```
  +--+---------------------------+
  |  | 인셉션 (2010)              |   <- 한국어 제목 + 연도 (font-medium)
  |  | → 인셉션 (2010).mkv       |   <- 변경될 파일명 (text-xs text-accent)
  +--+---------------------------+
  ```
  - 포스터 썸네일: `32x48px rounded-sm` (TMDB w92 이미지)
  - 제목: `font-medium text-sm`
  - 새 파일명: `text-xs text-accent` 미리보기 (화살표 `→` 접두사)
- **Status 뱃지**: `variant="outline"` 초록 테두리 "Ready"
- **액션**: [Rename] 버튼 `variant="default" size="sm"` (accent 컬러)

##### 상태: `renaming` (이름 변경 처리 중)
```
| 1 | Inception.2010.1080p.mkv    | [Poster] 인셉션    | 2.1 GB | [...]    | [disabled] |
```
- **Status**: 스피너 아이콘 회전
- **액션 버튼**: 비활성화

##### 상태: `done` (완료)
```
| 1 | Inception.2010.1080p.mkv    | [Poster] 인셉션    | 2.1 GB | [Done]   | [Check]    |
|   |  (strikethrough)            | (2010)             |        |          |            |
```
- **원본 파일명**: `line-through text-muted-foreground` (취소선)
- **Status 뱃지**: `variant="default"` 초록 배경 "Done" + 체크 아이콘
- **액션**: 체크마크 아이콘 (비활성 상태, 완료 표시)
- **행 배경**: 미세하게 밝게 `bg-accent/5`

##### 상태: `error` (에러)
```
| 1 | Inception.2010.1080p.mkv    | TMDB match failed  | 2.1 GB | [Error]  | [Retry]    |
```
- **매칭 결과**: 에러 메시지 (`text-destructive text-xs`)
- **Status 뱃지**: `variant="destructive"` 빨간 "Error"
- **액션**: [Retry] 버튼 `variant="ghost" size="sm"`

### 3.5 빈 상태 (Empty State)
```
+----------------------------------------------------------+
|                                                           |
|              [ScanSearch icon - 48px, muted]              |
|                                                           |
|              No files scanned yet                         |
|              Enter a directory path above                 |
|              to start scanning for movies.                |
|                                                           |
+----------------------------------------------------------+
```
- **아이콘**: `ScanSearch` 48px, `text-muted-foreground/50`
- **제목**: `text-lg font-medium`
- **설명**: `text-sm text-muted-foreground`
- **컨테이너**: `flex flex-col items-center justify-center py-20`

---

## 4. Library 페이지 (`/library`)

처리 완료된 영화들의 아카이브. 포스터 기반 카드 그리드.

### 4.1 페이지 헤더
```
Library                                         24 movies
Your renamed movie collection.
```
- **제목**: "Library" (`text-2xl font-bold`)
- **영화 수**: 우측 카운트 뱃지 (`text-muted-foreground`)

### 4.2 영화 카드 그리드 (MovieGrid)
```
+----------+  +----------+  +----------+  +----------+
|          |  |          |  |          |  |          |
| [Poster] |  | [Poster] |  | [Poster] |  | [Poster] |
|          |  |          |  |          |  |          |
|----------|  |----------|  |----------|  |----------|
| 인셉션   |  | 아바타   |  | 듄: 파트2|  | 오펜하이 |
| (2010)   |  | (2009)   |  | (2024)   |  | 머 (2023)|
+----------+  +----------+  +----------+  +----------+
```

- **그리드**: `grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4`
- **반응형**: 2열 ~ 5열

### 4.3 영화 카드 (MovieCard)

```
+------------------+
|                  |
|                  |
|     [Poster      |   <- 2:3 비율 (aspect-[2/3])
|      Image]      |       w92 → w342 이미지 사용
|                  |       hover: scale-105, brightness
|                  |
|                  |
+------------------+
| 인셉션            |   <- 제목 (font-medium text-sm, truncate)
| 2010              |   <- 연도 (text-xs text-muted-foreground)
+------------------+
```

- **카드 컨테이너**: `group cursor-pointer rounded-lg overflow-hidden bg-card border hover:border-accent/50 transition-all`
- **포스터 영역**:
  - `aspect-[2/3] relative overflow-hidden`
  - 이미지: `object-cover` Next.js Image
  - 호버 효과: `group-hover:scale-105 transition-transform duration-300`
  - 포스터 없음: 회색 배경 + Film 아이콘 플레이스홀더
- **정보 영역**:
  - 패딩: `p-3`
  - 제목: `font-medium text-sm truncate`
  - 연도: `text-xs text-muted-foreground`
- **클릭**: 상세 다이얼로그 열기

### 4.4 영화 상세 다이얼로그 (MovieDetailDialog)

카드 클릭 시 열리는 모달.

```
+----------------------------------------------------------+
|  [Dialog]                                          [X]    |
|                                                           |
|  +--------+  인셉션 (2010)                                |
|  |        |  Inception                                    |
|  |[Poster]|                                               |
|  |        |  [2010-07-16]  [TMDB: 27205]                 |
|  |        |                                               |
|  +--------+  줄거리                                       |
|              타인의 꿈에 들어가 생각을 훔치는              |
|              도둑 돔 코브에게 마지막 임무가                |
|              주어진다. 생각을 훔치는 것이 아닌...          |
|                                                           |
|  ---                                                      |
|  File Info                                                |
|  Original: Inception.2010.1080p.BluRay.mkv                |
|  Renamed:  인셉션 (2010).mkv                              |
|  Path:     D:\Movies\인셉션 (2010).mkv                    |
|  Archived: 2025-01-15 14:30                               |
+----------------------------------------------------------+
```

- **다이얼로그**: Shadcn Dialog, `max-w-lg`
- **상단**: 포스터 (좌) + 메타정보 (우) 가로 배치
  - 포스터: `w-32 aspect-[2/3] rounded-md`
  - 제목: `text-xl font-bold`
  - 원제: `text-sm text-muted-foreground` (한국어 제목과 다를 경우)
  - 뱃지들: 개봉일, TMDB ID (`variant="secondary" text-xs`)
- **줄거리**: `text-sm leading-relaxed` (최대 5줄, 이후 생략)
- **구분선**: `Separator`
- **파일 정보**:
  - `text-xs font-mono` 스타일
  - 라벨: `text-muted-foreground` | 값: `text-foreground`

### 4.5 빈 상태
```
+----------------------------------------------------------+
|                                                           |
|              [LayoutGrid icon - 48px, muted]              |
|                                                           |
|              Your library is empty                        |
|              Scan and rename some movies                  |
|              to see them here.                            |
|                                                           |
|              [Go to Scanner ->]                           |
|                                                           |
+----------------------------------------------------------+
```
- **CTA 버튼**: "Go to Scanner" (`variant="outline"`, 링크 to `/`)

### 4.6 로딩 상태 (loading.tsx)
```
+----------+  +----------+  +----------+  +----------+
| [Skel]   |  | [Skel]   |  | [Skel]   |  | [Skel]   |
| [Skel]   |  | [Skel]   |  | [Skel]   |  | [Skel]   |
| [------] |  | [------] |  | [------] |  | [------] |
| [----]   |  | [----]   |  | [----]   |  | [----]   |
+----------+  +----------+  +----------+  +----------+
```
- Skeleton 컴포넌트 8~12개 그리드 배치
- 포스터 영역: `Skeleton aspect-[2/3]`
- 텍스트: `Skeleton h-4 w-3/4` + `Skeleton h-3 w-1/2`

---

## 5. Settings 페이지 (`/settings`)

API 키 상태 확인 및 앱 정보.

### 5.1 레이아웃
```
Settings
Application configuration and status.

+----------------------------------------------------------+
|  [Card] API Configuration                                 |
|                                                           |
|  TMDB API              [Connected]  (green badge)         |
|  Movie metadata and poster images                         |
|                                                           |
|  Google Translate API   [Not Set]   (gray badge)          |
|  Korean translation for English results                   |
|                                                           |
+----------------------------------------------------------+

+----------------------------------------------------------+
|  [Card] Database                                          |
|                                                           |
|  SQLite Status          [Active]    (green badge)         |
|  Total Movies           24                                |
|  Database Size          1.2 MB                            |
|                                                           |
+----------------------------------------------------------+

+----------------------------------------------------------+
|  [Card] About                                             |
|                                                           |
|  Movie Renamer Dashboard v1.0                             |
|  Built with Next.js, Shadcn/UI, Drizzle ORM              |
|  Port: 3033                                               |
|                                                           |
+----------------------------------------------------------+
```

### 5.2 API 상태 카드
- **카드 제목**: `text-lg font-semibold`
- **행 구조**: 라벨 (좌) + 뱃지 (우) 한 줄
- **뱃지 상태**:
  - Connected: `bg-green-500/10 text-green-500 border-green-500/20` + 원형 dot
  - Not Set: `variant="secondary"` 회색
  - Error: `variant="destructive"`
- **설명**: `text-xs text-muted-foreground`

### 5.3 데이터베이스 카드
- 같은 행 구조: 라벨 + 값
- 영화 수, DB 파일 크기 표시

---

## 6. 인터랙션 패턴

### 6.1 버튼 상태
| 상태 | 스타일 |
|------|--------|
| Default | 배경색 + 텍스트 |
| Hover | `brightness-110` 또는 `bg-accent/90` |
| Active/Pressed | `scale-95` (미세한 축소) |
| Loading | 스피너 아이콘 + 텍스트 변경, `pointer-events-none opacity-70` |
| Disabled | `opacity-50 cursor-not-allowed` |

### 6.2 일괄 처리 흐름 (Batch)
```
[Identify All 클릭]
    ↓
버튼 텍스트: "Identifying 0/12..."
    ↓
각 파일 순차 처리 (상태: idle → identifying → ready/error)
    ↓
완료 시 Toast: "12 movies identified (2 failed)"
    ↓
[Rename All 활성화]
    ↓
[Rename All 클릭]
    ↓
버튼 텍스트: "Renaming 0/10..."
    ↓
각 파일 순차 처리 (상태: ready → renaming → done/error)
    ↓
완료 시 Toast: "10 files renamed successfully"
```

### 6.3 Toast 메시지 목록
| 상황 | 타입 | 메시지 |
|------|------|--------|
| 스캔 완료 | success | "Found {n} video files" |
| 스캔 결과 없음 | info | "No video files found in this directory" |
| 잘못된 경로 | error | "Directory not found: {path}" |
| 식별 성공 | success | "Matched: {title} ({year})" |
| 식별 실패 | error | "No TMDB match found for: {filename}" |
| 이름 변경 성공 | success | "Renamed to: {newName}" |
| 이름 변경 실패 | error | "Failed to rename: {reason}" |
| 일괄 식별 완료 | success | "{n} movies identified ({m} failed)" |
| 일괄 이름 변경 완료 | success | "{n} files renamed successfully" |

### 6.4 키보드 단축키 (선택적 구현)
| 키 | 동작 |
|----|------|
| `Enter` (경로 입력 중) | 스캔 시작 |
| `Escape` (다이얼로그) | 닫기 |

---

## 7. 반응형 브레이크포인트

| 브레이크포인트 | 사이드바 | 그리드 열 | 테이블 |
|-------------|---------|---------|--------|
| < 640px (sm) | 숨김 (햄버거 메뉴) | 2열 | 가로 스크롤 |
| 640-768px (md) | 접힘 (아이콘) | 3열 | 일부 열 숨김 |
| 768-1024px (lg) | 접힘 (아이콘) | 4열 | 전체 표시 |
| > 1024px (xl) | 펼침 | 5열 | 전체 표시 |

---

## 8. 아이콘 매핑 (Lucide React)

| 용도 | 아이콘 | 사용처 |
|------|--------|--------|
| 스캔 메뉴 | `ScanSearch` | 사이드바, 빈 상태 |
| 라이브러리 메뉴 | `LayoutGrid` | 사이드바, 빈 상태 |
| 설정 메뉴 | `Settings` | 사이드바 |
| 스캔 버튼 | `FolderSearch` | FileScanner |
| 식별 버튼 | `Sparkles` | FileRow, BatchActions |
| 이름 변경 버튼 | `PenLine` | FileRow, BatchActions |
| 완료 | `Check` | FileRow 상태 |
| 에러 | `AlertCircle` | FileRow 상태 |
| 로딩 | `Loader2` (animate-spin) | 모든 로딩 상태 |
| 파일 | `Film` | 포스터 없는 경우 플레이스홀더 |
| 사이드바 접기 | `PanelLeftClose` | 사이드바 토글 |
| 사이드바 펼치기 | `PanelLeftOpen` | 사이드바 토글 |
| 닫기 | `X` | 다이얼로그 |
| 연결 상태 | `Wifi` / `WifiOff` | Settings 카드 |
| 데이터베이스 | `Database` | Settings 카드 |
| 정보 | `Info` | Settings About |
| 외부 링크 | `ExternalLink` | TMDB 링크 등 |

---

## 9. 파일별 상태 머신 (State Machine)

```
            [scan]
              |
              v
  +--------[idle]--------+
  |                      |
  | [identify]           |
  v                      |
[identifying]            |
  |         |            |
  | success | error      |
  v         v            |
[ready]   [error]--------+
  |         |   [retry]
  | [rename]|
  v         |
[renaming]  |
  |    |    |
  | ok | fail
  v    v
[done] [error]
```

| 상태 | 설명 | 허용 액션 |
|------|------|----------|
| `idle` | 스캔됨, 미식별 | Identify |
| `identifying` | TMDB 검색 중 | 없음 (대기) |
| `ready` | 매칭 완료, 변경 대기 | Rename |
| `renaming` | 파일 이름 변경 중 | 없음 (대기) |
| `done` | 완료 | 없음 |
| `error` | 에러 발생 | Retry (→ idle로 복귀) |

---

## 10. 데이터 표시 포맷

| 데이터 | 포맷 | 예시 |
|--------|------|------|
| 파일 크기 | 자동 단위 | `1.2 GB`, `850 MB`, `4.7 GB` |
| 날짜 | YYYY-MM-DD | `2024-03-15` |
| 연도 | 4자리 | `(2010)` |
| 파일명 | 모노스페이스 | `Inception.2010.1080p.mkv` |
| 새 파일명 | 액센트 컬러 | `→ 인셉션 (2010).mkv` |
| TMDB ID | 뱃지 | `TMDB: 27205` |

---

## 11. 에러 처리 UI

### 11.1 에러 바운더리 (`error.tsx`)
```
+----------------------------------------------------------+
|                                                           |
|              [AlertCircle icon - 48px, red]               |
|                                                           |
|              Something went wrong                         |
|              {error.message}                              |
|                                                           |
|              [Try Again]                                  |
|                                                           |
+----------------------------------------------------------+
```

### 11.2 인라인 에러 (FileRow)
- 에러 메시지를 매칭 결과 영역에 빨간 텍스트로 표시
- Retry 버튼으로 재시도 가능

### 11.3 경로 에러
- 존재하지 않는 경로: Toast 에러 + 인풋 테두리 빨간색 (`border-destructive`)
- 빈 디렉토리: Toast 정보 + "0 files found"

---

## 12. 애니메이션

| 요소 | 애니메이션 | 설정 |
|------|----------|------|
| 사이드바 토글 | 너비 변화 | `transition-all duration-300` |
| 카드 호버 | 포스터 확대 | `group-hover:scale-105 duration-300` |
| 뱃지 상태 변경 | 페이드 | `transition-colors duration-200` |
| 로딩 스피너 | 회전 | `animate-spin` |
| 스켈레톤 | 펄스 | `animate-pulse` (Shadcn 기본) |
| 다이얼로그 | 페이드+스케일 | Shadcn Dialog 기본 |
| Toast | 슬라이드 인 | Sonner 기본 |
| 행 완료 | 배경 하이라이트 | `bg-accent/5 transition-colors` |

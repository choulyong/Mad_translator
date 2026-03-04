# Low Level Design (LLD) - Movie Renamer Dashboard

## 1. Database Schema (SQLite + Drizzle)

### `movies` Table
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `text` | PRIMARY KEY | UUID |
| `original_name` | `text` | NOT NULL | 원본 파일명 |
| `new_name` | `text` | NOT NULL | 변경된 파일명 |
| `file_path` | `text` | NOT NULL | 파일 전체 경로 |
| `tmdb_id` | `integer` | | TMDB 영화 ID |
| `title` | `text` | NOT NULL | 영화 제목 (한국어) |
| `release_date` | `text` | | 개봉일 (YYYY-MM-DD) |
| `poster_path` | `text` | | TMDB 포스터 URL |
| `overview` | `text` | | 줄거리 |
| `created_at` | `text` | DEFAULT (ISO string) | 생성일 |

## 2. Server Actions Logic

### 2.1 `scanDirectory(path: string)`
- **Input**: Directory path string.
- **Process**:
  - Check if path exists & is directory.
  - `fs.readdir` read content.
  - Filter by extensions `['.mkv', '.mp4', '.avi']`.
  - Get `fs.stat` for file details (size, created time).
- **Output**: `FileItem[]` (name, path, size, is Directory).

### 2.2 `identifyMovie(filename: string)`
- **Input**: Filename string.
- **Process**:
  - Regex or `parse-torrent-title` to extract `query` (title) and `year`.
  - `fetch` TMDB `/search/movie` with `query` & `year` & `language=ko-KR`.
  - If results empty, search with `language=en-US`.
    - If found in English, translate `overview` using Google Translate API (free tier or simple mapping). *For MVP, English overview fallback is acceptable if translation fails.*
- **Output**: `MovieMetadata` (tmdbId, title, year, poster, overview).

### 2.3 `processRename(fileId: string, metadata: MovieMetadata)`
- **Input**: File identifier (path), target metadata.
- **Process**:
  - Validate file still exists.
  - Construct new filename: `${metadata.title} (${metadata.year}).${ext}`.
  - Sanitize filename (remove illegal chars `\/:*?"<>|`).
  - Check for collision -> Append `_1`, `_2`.
  - `fs.rename(oldPath, newPath)`.
  - `db.insert(movies).values(...)`.
- **Output**: Success/Failure status.

## 3. Component Structure (Components)

### `Sidebar`
- Navigation links: Scan, Library, Settings.

### `FileScanner` (Client Component)
- State: `path`, `files`, `scanning` (boolean).
- UI: Input field, Scan button.

### `FileList` (Client Component)
- Props: `files`.
- UI: Table/List view.
- Actions: "Identify" button per row.

### `MovieCard` (Client Component)
- Props: `movie` (DB record).
- UI: Poster image, Title, Year.

## 4. State Management (Zustand)

### `useScanStore`
- `path`: string
- `files`: Array<{ name, path, status: 'idle' | 'identifying' | 'ready' | 'processing' | 'done' }>
- `setPath`, `setFiles`, `updateFileStatus`

## 5. Technology Specifics
- **TMDB Client**: Use native `fetch` with Bearer token.
- **Translation**: `google-translate-api-browser` (check compatibility with Node environment) or direct API call if key available. *Fallback: detailed English description.*

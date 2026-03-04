# Implementation Plan - Movie Renamer Dashboard

# Goal Description
Build a local file management dashboard to identify, rename, and organize movie files using TMDB metadata. The app runs locally on port 3033.

## User Review Required
> [!IMPORTANT]
> - TMDB API Key is required. Will use a placeholder/env variable instruction.
> - File system operations are irreversible. A "Dry Run" or explicit confirmation step is included.

## Proposed Changes

### 1. Setup & Configuration
#### [NEW] [.env.local](file:///C:/Vibe Coding/rename/.env.local)
- Add `TMDB_API_KEY`
- Add `DATABASE_URL` (e.g., `file:local.db`)

### 2. Database Layer
#### [NEW] [db/schema.ts](file:///C:/Vibe Coding/rename/db/schema.ts)
- Define `movies` table using Drizzle.
#### [NEW] [db/index.ts](file:///C:/Vibe Coding/rename/db/index.ts)
- Initialize Drizzle with `better-sqlite3`.
#### [MODIFY] [package.json](file:///C:/Vibe Coding/rename/package.json)
- Add `drizzle-orm`, `better-sqlite3`, `dotenv`.
- Add `drizzle-kit` for migrations.

### 3. Server Actions (Backend Logic)
#### [NEW] [actions/file-system.ts](file:///C:/Vibe Coding/rename/actions/file-system.ts)
- Implement `scanDirectoryAction`.
- Implement `renameFileAction`.
#### [NEW] [actions/metadata.ts](file:///C:/Vibe Coding/rename/actions/metadata.ts)
- Implement `searchMovieAction` (TMDB wrapper).
- Implement response parsing.

### 4. UI Implementation
#### [NEW] [store/scan-store.ts](file:///C:/Vibe Coding/rename/store/scan-store.ts)
- Zustand store for file list and processing status.
#### [NEW] [components/domain/scanner.tsx](file:///C:/Vibe Coding/rename/components/domain/scanner.tsx)
- Input path, Scan button.
- List view of files.
#### [NEW] [app/page.tsx](file:///C:/Vibe Coding/rename/app/page.tsx)
- Assemble Dashboard layout.

## Verification Plan

### Automated Tests
- None planned for MVP (Focus on manual verification of FS operations).

### Manual Verification
1. **Setup**: Create a `test-folder` with dummy video files (e.g., `Inception.2010.mkv`, `Avatar.avi`).
2. **Scan**: Input path to `test-folder` and verify list appears.
3. **Identify**: Click identify and verify correct TMDB data is fetched.
4. **Rename**: Execute rename and verify file system changes and DB entry.

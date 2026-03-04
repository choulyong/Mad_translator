# 사용자 매뉴얼 (User Manual)

## 1. 시작하기 (Getting Started)

### 필수 요구사항
- **Node.js**: v18.17.0 이상
- **TMDB API Key**: [TMDB 설정 페이지](https://www.themoviedb.org/settings/api)에서 발급 필요.

### 설치 및 실행
1. 프로젝트 폴더에서 터미널 열기.
2. 의존성 설치:
   ```bash
   npm install
   ```
3. 환경 변수 설정:
   `.env.local` 파일을 생성하고 키 입력.
   ```env
   TMDB_API_KEY=your_api_key_here
   DATABASE_URL=file:local.db
   ```
4. 개발 서버 실행:
   ```bash
   npm run dev
   ```
5. 브라우저 접속: `http://localhost:3033`

## 2. 기능 가이드

### 📁 스캔 (Scan)
1. **경로 입력**: 영화 파일이 있는 폴더의 절대 경로를 입력하세요. (예: `D:\Movies`)
2. **스캔 버튼 클릭**: 하위 폴더는 현재 버전에서 제외됩니다 (옵션).
3. **목록 확인**: 발견된 비디오 파일(.mkv, .mp4, .avi) 목록이 표시됩니다.

### 🎬 식별 (Identify)
1. 목록에서 **Identify** 버튼을 클릭하면 TMDB에서 영화 정보를 검색합니다.
2. 매칭된 영화 제목과 포스터가 미리보기에 나타납니다.
3. 정보가 정확한지 확인하세요. (한국어 제목 우선, 없을 시 영문 + 번역)

### ✍️ 이름 변경 (Rename)
1. **Rename** 버튼을 클릭하면 실제 파일 이름이 변경됩니다.
2. 변경 규칙: `한국어 제목 (연도).확장자`
3. 변경 내역은 **Library** 탭의 데이터베이스에 자동 저장됩니다.
4. **주의**: 파일 이름 변경은 되돌릴 수 없으니 신중하게 진행하세요.

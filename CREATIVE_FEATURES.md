# Creative & Advanced Features (Future Roadmap)

## 1. AI Analysis & Metadata Enrichment (Vibe Highlight)
단순한 메타데이터 수집을 넘어, **영화의 내용을 분석하고 감성을 태깅**하는 기능.
- **Vision AI Scanning**: 영화 포스터나 주요 스틸컷에서 색상 팔레트 추출 -> UI 테마 자동 변경.
- **Scene Detection**: 주요 명장면 썸네일 자동 생성 및 GIF 프리뷰 제공.
- **Mood Tagging**: 줄거리를 NLP로 분석하여 `#긴장감넘치는`, `#우울한`, `#화려한` 태그 자동 생성.

## 2. Automatic Subtitle Sync (Subtitle Hunter)
영화 식별 후 자막 파일(.smi, .srt) 존재 여부를 확인하고, 없으면 자동으로 다운로드.
- **Hash Matching**: 파일 해시를 계산하여 정확한 버전의 자막 검색 (OpenSubtitles API).
- **Auto-translate**: 영문 자막만 있을 경우, DeepL API를 연동하여 고품질 한글 자막 실시간 생성.

## 3. "Torrent Clean" Logic (Smart Renamer Pro)
파일명 정리를 넘어, 다운로드된 폴더 내부를 완벽하게 정화.
- **Junk Remover**: `.nfo`, `.txt`, `Sample/`, `Proof/` 등 불필요한 파일 및 폴더 자동 삭제.
- **De-clutter**: 중첩된 폴더 구조를 평탄화 (Flatten)하여 `Movies/` 루트로 이동.

## 4. Mobile Remote Control (Couch Potato Mode)
PC 앞에 앉아있지 않아도, 침대에 누워서 파일 정리를 수행.
- **PWA Support**: 모바일 최적화 웹 앱 제공.
- **Push Notification**: 대용량 스캔 완료 시 모바일로 알림 발송.
- **QR Login**: 로컬 네트워크 내에서 QR 코드로 간편 접속.

## 5. Personal Movie Analytics
나만의 시청 습관과 라이브러리 통계 시각화.
- **Genre Distribution Chart**: 내 라이브러리의 장르별 분포도 (Pie Chart).
- **Decade Timeline**: 1990s vs 2020s 영화 비율 분석.
- **Duplicate Finder**: 해상도만 다른 중복 영화 자동 검출 (4K vs 1080p) 및 정리 제안.

# Restore Guide — Backend Orchestration 변경 전 백업

## 백업 일시
2026-02-16

## 백업 파일 목록

| 원본 | 백업 |
|------|------|
| `lib/services/translation-service.ts` | `lib/services/translation-service.ts.bak-pre-backend-orchestration` |
| `C:\Vibe Coding\Subtitle\backend\app\api\subtitles.py` | `subtitles.py.bak-pre-backend-orchestration` |
| `C:\Vibe Coding\Subtitle\backend\app\services\vertex_ai.py` | `vertex_ai.py.bak-pre-backend-orchestration` |

## 복원 명령어

```bash
# 프론트엔드
cp "/c/Vibe Coding/rename/lib/services/translation-service.ts.bak-pre-backend-orchestration" "/c/Vibe Coding/rename/lib/services/translation-service.ts"

# 백엔드 API
cp "/c/Vibe Coding/Subtitle/backend/app/api/subtitles.py.bak-pre-backend-orchestration" "/c/Vibe Coding/Subtitle/backend/app/api/subtitles.py"

# 백엔드 Vertex AI
cp "/c/Vibe Coding/Subtitle/backend/app/services/vertex_ai.py.bak-pre-backend-orchestration" "/c/Vibe Coding/Subtitle/backend/app/services/vertex_ai.py"
```

## 복원 후 재시작

```bash
# 프론트엔드 빌드 + 재시작
cd "/c/Vibe Coding/rename" && npm run build
pm2 restart movie-rename

# 백엔드 재시작
pm2 restart subtitle-backend
```

## 백업 시점 상태
- 병렬 처리 (Pass 1/3/3.5/4) 적용됨
- Tone Archetype 시스템 적용됨
- Session Buffer 적용됨
- Speech Lock 해제 조건 (scene break / mood change) 적용됨
- Pass 3.5 원문 유사도 안전 필터 적용됨
- 백엔드 파서 버그 수정 완료 ({id, ko} 형식 지원)
- k_cinematic_prompt.py 말투 결정 순서 핵심 요약 추가됨

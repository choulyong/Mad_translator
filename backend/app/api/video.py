import os
from fastapi import APIRouter, HTTPException, Header
from fastapi.responses import StreamingResponse

router = APIRouter()

@router.get("/stream")
async def stream_video(path: str, range: str = Header(None)):
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Video file not found")
    
    file_size = os.path.getsize(path)
    # Range parsing logic (Simplified for Aura Prototype)
    # 실제 운영시에는 정확한 바이트 범위 계산 필요
    def iterfile():
        with open(path, mode="rb") as f:
            yield from f

    return StreamingResponse(iterfile(), media_type="video/mp4")

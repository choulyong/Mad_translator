import os
import asyncio
import time
from pathlib import Path
from dotenv import load_dotenv

# .env 파일 로드 (backend 폴더 기준)
env_path = Path(__file__).parent.parent / ".env"
load_dotenv(env_path)

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from app.api import subtitles, metadata, video, strategy
from app.database import init_db

app = FastAPI(title="Subtitle OS - Antigravity Aura API")

# Server startup timestamp (for frontend restart detection)
_server_start_time = time.time()

# Initialize database (graceful - continues even if DB fails)
try:
    init_db()
except Exception as e:
    print(f"[STARTUP] Database init warning: {str(e)[:80]}")

# CORS 설정 (모든 Origin 허용 - 개발/배포 통합)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,  # allow_origins=["*"]와 함께 사용 시 False
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    return {"status": "Aura Logic Gate Operational", "version": "2.0"}

@app.api_route("/api/v1/health", methods=["GET", "HEAD"])
async def health_check():
    return {
        "status": "ok",
        "service": "Subtitle OS Backend",
        "startup_time": _server_start_time
    }

# API 라우트 등록
app.include_router(subtitles.router, prefix="/api/v1/subtitles", tags=["Subtitles"])
app.include_router(metadata.router, prefix="/api/v1/metadata", tags=["Metadata"])
app.include_router(video.router, prefix="/api/v1/video", tags=["Video"])
app.include_router(strategy.router, prefix="/api/v1/strategy", tags=["Strategy"])

# 🔄 서버 시작 시 Job 상태 복구
@app.on_event("startup")
async def startup_event():
    """서버 재시작 후 진행 중이던 Job 복구 및 주기적 정리 시작"""
    from app.database import load_all_running_jobs
    from app.api.subtitles import _jobs, _periodic_cleanup

    # Load all running jobs from database
    try:
        running_jobs = load_all_running_jobs()
        _jobs.update(running_jobs)
        print(f"[STARTUP] Recovered {len(running_jobs)} jobs from database")
    except Exception as e:
        print(f"[WARN] Failed to load jobs from database: {e}")
        print("[WARN] Proceeding without database job recovery")

    # ✅ Start periodic cleanup task to prevent memory leaks
    asyncio.create_task(_periodic_cleanup())
    print("[STARTUP] Started periodic job cleanup task (runs every 30 seconds)")


@app.on_event("shutdown")
async def shutdown_event():
    """Graceful shutdown - 진행 중인 작업 정리 후 종료"""
    print("[SHUTDOWN] Server shutting down gracefully...")
    try:
        from app.api.subtitles import _jobs
        from app.database import _save_jobs_to_file

        # Job 상태를 파일에 저장 (복구용)
        _save_jobs_to_file()
        print(f"[SHUTDOWN] {len(_jobs)} jobs saved to database")
    except Exception as e:
        print(f"[SHUTDOWN] Warning during cleanup: {e}")

    print("[SHUTDOWN] Server shutdown complete")


# ═══════════════════════════════════════════════════════════════════
# 🔴 WebSocket Manager (실시간 진행률 스트림)
# ═══════════════════════════════════════════════════════════════════

class WebSocketManager:
    """WebSocket 연결 관리 — 여러 클라이언트에게 job 업데이트 브로드캐스트"""
    def __init__(self):
        self.active_connections: dict = {}  # {job_id: [WebSocket, ...]}

    async def connect(self, job_id: str, websocket: WebSocket):
        await websocket.accept()
        if job_id not in self.active_connections:
            self.active_connections[job_id] = []
        self.active_connections[job_id].append(websocket)
        print(f"[WS] Client connected to job {job_id} (total: {len(self.active_connections[job_id])})")

    async def disconnect(self, job_id: str, websocket: WebSocket):
        if job_id in self.active_connections:
            self.active_connections[job_id].remove(websocket)
            if not self.active_connections[job_id]:
                del self.active_connections[job_id]
                print(f"[WS] Job {job_id} closed (no clients)")
            else:
                print(f"[WS] Client disconnected from job {job_id} (remaining: {len(self.active_connections[job_id])})")

    async def broadcast(self, job_id: str, message: dict):
        """모든 클라이언트에게 메시지 전송"""
        if job_id not in self.active_connections:
            return

        disconnected = []
        for ws in self.active_connections[job_id]:
            try:
                await ws.send_json(message)
            except Exception as e:
                print(f"[WS] Broadcast error: {e}")
                disconnected.append(ws)

        # 끊긴 연결 정리
        for ws in disconnected:
            await self.disconnect(job_id, ws)


ws_manager = WebSocketManager()

# WebSocket Manager를 subtitles 모듈에 주입 (circular import 회피)
import app.api.subtitles as subtitles_module
subtitles_module.ws_manager = ws_manager


@app.websocket("/api/v1/subtitles/ws/{job_id}")
async def websocket_endpoint(websocket: WebSocket, job_id: str):
    """
    WebSocket 엔드포인트 — 실시간 번역 진행률 스트림

    사용:
      ws://localhost:8020/api/v1/subtitles/ws/{job_id}

    메시지:
      {
        "event": "progress_update",
        "progress": 45,
        "current_pass": "Pass 1: 번역 중",
        "timestamp": 1234567890.0
      }
    """
    await ws_manager.connect(job_id, websocket)

    # 연결 후 초기 상태 전송
    try:
        from app.api.subtitles import _jobs
        if job_id in _jobs:
            job = _jobs[job_id]
            await websocket.send_json({
                "event": "initial_state",
                "job_id": job_id,
                "status": job.get("status"),
                "progress": job.get("progress", 0),
                "current_pass": job.get("current_pass", ""),
                "partial_subtitles": job.get("partial_subtitles", [])[-50:],  # 최근 50개만
            })
    except Exception as e:
        print(f"[WS] Initial state send error: {e}")

    try:
        while True:
            # 클라이언트로부터의 메시지 수신 (하트비트용)
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_json({"event": "pong"})
    except WebSocketDisconnect:
        await ws_manager.disconnect(job_id, websocket)
    except Exception as e:
        print(f"[WS] Connection error: {e}")
        try:
            await ws_manager.disconnect(job_id, websocket)
        except:
            pass

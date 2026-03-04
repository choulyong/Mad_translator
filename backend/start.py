"""
rename-backend 시작 스크립트.
포트 8033을 점유하는 좀비 프로세스를 먼저 정리한 후 uvicorn을 실행합니다.

Windows에서 os.execv는 새 프로세스를 만들고 자신을 종료하므로
PM2가 부모 프로세스 종료를 감지하여 재시작 루프에 빠집니다.
대신 subprocess.Popen + wait()으로 부모가 자식을 감싸는 구조를 사용합니다.
"""
import subprocess
import sys
import os
import time
import signal


PORT = 8033
_proc = None


def kill_port(port: int):
    try:
        result = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True, text=True
        )
        for line in result.stdout.splitlines():
            if f":{port} " in line and "LISTENING" in line:
                parts = line.strip().split()
                pid = int(parts[-1])
                if pid == os.getpid():
                    continue
                try:
                    os.kill(pid, 9)
                    print(f"[STARTUP] 포트 {port} 점유 프로세스 종료: PID {pid}", flush=True)
                    time.sleep(1)
                except Exception as e:
                    print(f"[STARTUP] PID {pid} 종료 실패: {e}", flush=True)
    except Exception as e:
        print(f"[STARTUP] 포트 정리 실패: {e}", flush=True)


def handle_term(sig, frame):
    """PM2의 SIGTERM을 받아 uvicorn 자식 프로세스에 전달."""
    if _proc and _proc.poll() is None:
        _proc.terminate()
        try:
            _proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _proc.kill()
    sys.exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, handle_term)
    signal.signal(signal.SIGINT, handle_term)

    kill_port(PORT)

    _proc = subprocess.Popen(
        [
            sys.executable, "-m", "uvicorn",
            "app.main:app",
            "--host", "0.0.0.0",
            "--port", str(PORT),
            "--timeout-graceful-shutdown", "3",
        ]
    )

    returncode = _proc.wait()
    sys.exit(returncode)

module.exports = {
  apps: [
    {
      name: "movie-rename",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3033",
      cwd: "C:\\Vibe Coding\\rename",
      env: {
        NODE_ENV: "production",
        NEXT_PUBLIC_API_BASE: "http://localhost:8033/api/v1",
      },
    },
    {
      name: "rename-backend",
      script: "venv2/Scripts/python.exe",
      args: "start.py",
      cwd: "C:\\Vibe Coding\\rename\\backend",
      interpreter: "none",
      kill_timeout: 8000,
      restart_delay: 3000,
      env: {
        PYTHONPATH: "C:\\Vibe Coding\\rename\\backend",
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8"
      }
    }
  ],
};

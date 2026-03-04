@echo off
REM 복사할 파일 목록
set SOURCE_DIR=C:\Vibe Coding\Subtitle\backend\app

set FILES=^
api\subtitles.py,lib\subtitle_engine\subtitles.py ^
services\vertex_ai.py,lib\subtitle_engine\vertex_ai.py ^
core\subtitle_translation_prompt.py,lib\subtitle_engine\subtitle_translation_prompt.py

echo Creating subtitle_engine folder...
mkdir lib\subtitle_engine 2>nul

for %%a in (%FILES%) do (
    for /f "tokens=1,2 delims=," %%i in ("%%a") do (
        echo Copying %%i -^> %%j
        copy /Y "%SOURCE_DIR%\%%i" "%%j"
    )
)

echo.
echo Done! Files copied to lib\subtitle_engine\
dir lib\subtitle_engine
pause

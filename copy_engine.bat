@echo off
REM 사용법: copy_engine.bat [목적지폴더]
REM 예: copy_engine.bat C:\Vibe Coding\rename

if "%~1"=="" (
    echo 사용법: copy_engine.bat [목적지폴더]
    echo 예: copy_engine.bat C:\Vibe Coding\rename
    pause
    exit /b 1
)

set DEST=%~1
set SOURCE=C:\Vibe Coding\Subtitle\backend\app

echo ========================================
echo Subtitle Engine 파일 복사
echo Source: %SOURCE%
echo Dest: %DEST%
echo ========================================
echo.

echo Creating folder: %DEST%\lib\subtitle_engine
mkdir "%DEST%\lib\subtitle_engine" 2>nul

echo.
echo Copying subtitles.py...
copy /Y "%SOURCE%\api\subtitles.py" "%DEST%\lib\subtitle_engine\subtitles.py"

echo Copying vertex_ai.py...
copy /Y "%SOURCE%\services\vertex_ai.py" "%DEST%\lib\subtitle_engine\vertex_ai.py"

echo Copying subtitle_translation_prompt.py...
copy /Y "%SOURCE%\core\subtitle_translation_prompt.py" "%DEST%\lib\subtitle_engine\subtitle_translation_prompt.py"

echo.
echo ========================================
echo Complete!
echo ========================================
dir "%DEST%\lib\subtitle_engine"
pause

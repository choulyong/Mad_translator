@echo off
echo Subtitle Engine 파일 복사 중...

xcopy /Y /E "C:\Vibe Coding\Subtitle\backend\app\api\subtitles.py" "subtitles.py"
xcopy /Y /E "C:\Vibe Coding\Subtitle\backend\app\services\vertex_ai.py" "vertex_ai.py"
xcopy /Y /E "C:\Vibe Coding\Subtitle\backend\app\core\subtitle_translation_prompt.py" "subtitle_translation_prompt.py"

echo.
echo 완료!
dir /B *.py
pause

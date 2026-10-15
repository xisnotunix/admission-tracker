@echo off
rem Запуск трекера локально: двойной щелчок по этому файлу.
rem Браузер не даёт странице, открытой как файл (file:///), читать data/*.json,
rem поэтому поднимаем маленький локальный сервер.
chcp 65001 >nul
cd /d "%~dp0"
echo Трекер поступления: http://localhost:8765
echo Чтобы остановить, закройте это окно.
start "" http://localhost:8765/
python -m http.server 8765 --bind 127.0.0.1
pause

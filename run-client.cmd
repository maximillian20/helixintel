@echo off
setlocal
set PROJECT_ROOT=%~dp0
"C:\Program Files\nodejs\node.exe" "%PROJECT_ROOT%node_modules\vite\bin\vite.js" --host 0.0.0.0 --port 5173

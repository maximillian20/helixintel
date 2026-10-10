@echo off
setlocal
set PROJECT_ROOT=%~dp0
"C:\Program Files\nodejs\node.exe" "%PROJECT_ROOT%node_modules\tsx\dist\cli.mjs" watch server/index.ts

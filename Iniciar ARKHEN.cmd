@echo off
setlocal
cd /d "%~dp0"
call npm.cmd start
if errorlevel 1 (
  echo.
  echo Nao foi possivel iniciar o ARKHEN. Confira o erro acima.
  pause
)
endlocal

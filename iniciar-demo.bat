@echo off
chcp 65001 >nul
title Demo chat influencers

rem Arranca el chat (puerto 3000) y el tunel de ngrok con el dominio fijo.
rem Cierra esta ventana o pulsa Ctrl+C en las otras dos para detener la demo.

cd /d "%~dp0"

echo Iniciando el chat...
start "Chat (npm start)" cmd /k "npm start"

timeout /t 4 /nobreak >nul

echo Iniciando ngrok...
start "ngrok" cmd /k "C:\laragon\bin\ngrok\ngrok.exe http --url=poplar-bath-filter.ngrok-free.dev 3000"

timeout /t 4 /nobreak >nul

echo.
echo Demo lista:
echo   Chat publico:   https://poplar-bath-filter.ngrok-free.dev/IG01gnpo
echo   Panel de ngrok: http://127.0.0.1:4040
echo.
echo Abriendo el link de Instagram de Sandra...
start "" "https://poplar-bath-filter.ngrok-free.dev/IG01gnpo"
pause

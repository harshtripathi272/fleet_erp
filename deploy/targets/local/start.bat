@echo off
rem Double-click to start this company on Windows (#103): a copy of its own, with its own database and files.
rem The first time it makes .env with a new sign-in key and a first password for the owner, and shows that password.
setlocal
cd /d "%~dp0"

where docker >nul 2>nul || (echo Docker isn't installed. Install Docker Desktop, start it, then run this again: https://www.docker.com/products/docker-desktop/ & pause & exit /b 1)
docker info >nul 2>nul || (echo Docker is installed but not running. Start Docker Desktop, wait until it says it is running, then run this again. & pause & exit /b 1)

for /f "usebackq tokens=1,* delims==" %%a in ("deploy\kit.env") do (
  if "%%a"=="COMPANY" set "COMPANY=%%b"
  if "%%a"=="PORT" set "PORT=%%b"
  if "%%a"=="OWNER_EMAIL" set "OWNER_EMAIL=%%b"
)
if "%PORT%"=="" set "PORT=8080"

if not exist ".env" (
  powershell -NoProfile -Command ^
    "$r = { param($n) -join ((48..57)+(65..90)+(97..122) | Get-Random -Count $n | ForEach-Object {[char]$_}) };" ^
    "$jwt = & $r 48; $pw = 'Fleet' + (& $r 10) + '7';" ^
    "(Get-Content '.env.example') -replace '^JWT_SECRET=.*', ('JWT_SECRET=' + $jwt) -replace '^OWNER_PASSWORD=.*', ('OWNER_PASSWORD=' + $pw) | Set-Content -Encoding ascii '.env';" ^
    "Write-Host ''; Write-Host ('First start. Sign in as %OWNER_EMAIL% with this password (it is also in .env; change it under Your account):'); Write-Host ''; Write-Host ('    ' + $pw); Write-Host ''"
)

echo Building and starting. The first time takes a few minutes.
docker compose --project-name fleet-%COMPANY%-local up -d --build || (pause & exit /b 1)

echo Waiting for it to answer...
for /l %%i in (1,1,120) do (
  curl -fsS "http://localhost:%PORT%/api/v1/health/ready" >nul 2>nul && (
    echo Ready: http://localhost:%PORT%
    start "" "http://localhost:%PORT%"
    pause
    exit /b 0
  )
  timeout /t 2 /nobreak >nul
)
echo It hasn't answered after four minutes. See why with: docker compose --project-name fleet-%COMPANY%-local logs app
pause
exit /b 1

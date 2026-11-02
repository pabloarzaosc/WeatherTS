@echo off
rem WeatherTS in the browser on a Windows machine that has nothing installed: gets
rem Node.js and Python if they are missing, then the app's packages, starts the app
rem and opens http://localhost:1420/. The first run takes several minutes and needs
rem internet; after that it starts straight away. Ctrl+C stops it.
setlocal
cd /d "%~dp0"
title WeatherTS

where winget >nul 2>nul
set "HAS_WINGET=%errorlevel%"
set "WINGET=winget install -e --silent --source winget --accept-package-agreements --accept-source-agreements"

rem --- Node.js 20 or newer -----------------------------------------------------
call :node_ok
if not errorlevel 1 goto node_done
if not "%HAS_WINGET%"=="0" goto no_winget
echo [1/4] Installing Node.js...
%WINGET% --id OpenJS.NodeJS.LTS
call :node_ok
if not errorlevel 1 goto node_done
echo Node.js did not install. Get it from https://nodejs.org and run this again.
goto fail
:node_done

rem --- Python 3.13, the version the backend's packages are known to work on -----
call :find_python
if defined PY goto python_done
if not "%HAS_WINGET%"=="0" goto no_winget
echo [2/4] Installing Python 3.13...
%WINGET% --id Python.Python.3.13 --scope user
call :find_python
if defined PY goto python_done
echo Python did not install. Get 3.13 from https://www.python.org and run this again.
goto fail
:python_done

rem --- The backend's packages ---------------------------------------------------
set "VENV=backend\.venv\Scripts\python.exe"
rem A .venv copied from another computer points at a Python that is not here.
if not exist "%VENV%" goto make_venv
"%VENV%" -c "" >nul 2>nul
if not errorlevel 1 goto venv_done
:make_venv
echo [3/4] Creating the Python environment...
%PY% -m venv --clear backend\.venv
if errorlevel 1 goto fail
:venv_done
fc /b backend\requirements.txt backend\.venv\.ready >nul 2>nul
if not errorlevel 1 goto pip_done
echo [3/4] Installing the backend's packages...
"%VENV%" -m pip install --upgrade pip
if errorlevel 1 goto fail
"%VENV%" -m pip install -r backend\requirements.txt
if errorlevel 1 goto fail
rem Its own requirements do not install on Python 3.13; requirements.txt has what it needs.
"%VENV%" -m pip install sharppy --no-deps
if errorlevel 1 goto fail
copy /y backend\requirements.txt backend\.venv\.ready >nul
:pip_done

rem --- The app's packages -------------------------------------------------------
rem Electron is only for the desktop build; the browser does not need its 100 MB.
set "ELECTRON_SKIP_BINARY_DOWNLOAD=1"
if exist node_modules\vite\bin\vite.js goto npm_update
echo [4/4] Installing the app's packages...
call npm ci --no-audit --no-fund
if errorlevel 1 goto fail
copy /y package-lock.json node_modules\.ready >nul
goto npm_done
:npm_update
fc /b package-lock.json node_modules\.ready >nul 2>nul
if not errorlevel 1 goto npm_done
echo [4/4] Updating the app's packages...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail
copy /y package-lock.json node_modules\.ready >nul
:npm_done

echo.
echo Starting WeatherTS: the browser opens at http://localhost:1420/ when it is ready.
echo Keep this window open. Ctrl+C stops it.
echo.
node scripts\dev-all.mjs --open
if errorlevel 1 goto fail
exit /b 0

:no_winget
echo winget is missing, so Node.js and Python cannot be installed from here.
echo Install Node.js from https://nodejs.org and Python 3.13 from https://www.python.org, then run this again.
:fail
echo.
echo It stopped before the app started: the message above says why.
pause
exit /b 1

rem Errorlevel 0 when a new enough Node.js answers. A fresh install is not on this
rem window's PATH yet, so its folder is added first.
:node_ok
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 exit /b 1
node -e "process.exit(+process.versions.node.split('.')[0]>=20?0:1)"
exit /b %errorlevel%

rem Sets PY to a Python 3.13: the launcher, the usual install folders, then the PATH.
:find_python
set "PY="
py -3.13 -c "" >nul 2>nul
if not errorlevel 1 set "PY=py -3.13"
if defined PY exit /b 0
call :try_python "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if defined PY exit /b 0
call :try_python "%LOCALAPPDATA%\Python\pythoncore-3.13-64\python.exe"
if defined PY exit /b 0
call :try_python "%ProgramFiles%\Python313\python.exe"
if defined PY exit /b 0
python -c "import sys;sys.exit(sys.version_info[:2]!=(3,13))" >nul 2>nul
if not errorlevel 1 set "PY=python"
exit /b 0

:try_python
if exist "%~1" set PY="%~1"
exit /b 0

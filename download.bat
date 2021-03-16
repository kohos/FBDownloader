@echo off
for /d %%a in (data\*) do (
echo %%~na
node app.js %%~na
)
pause
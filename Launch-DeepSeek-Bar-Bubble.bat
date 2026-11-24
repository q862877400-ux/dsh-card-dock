@echo off
chcp 65001 >nul
title DeepSeek-Bar 100%% Native Browser Bubble Twin Launcher
cd /d "%~dp0"
echo [dsh-card-dock] 正在检测本机 Edge / Chrome 并拉起无标题栏 24px 圆角原版输入框分身...
echo 提示：如需绑定跟随某个软件（例如 SolidWorks），可在命令行附加 --bind-process SLDWORKS.exe
python desktop-launcher\dsh_browser_bubble.py --dsh-url http://127.0.0.1:3000 %*
pause

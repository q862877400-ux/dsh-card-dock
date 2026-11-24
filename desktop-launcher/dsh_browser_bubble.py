#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
desktop-launcher/dsh_browser_bubble.py — 100% 原生浏览器无边框圆角气泡分身启动器 (v1.0.0)
核心原理：
1. 自动检测用户电脑已安装的 Chromium 内核浏览器（优先级：Microsoft Edge -> Google Chrome -> Brave / Vivaldi / Chromium / 360极速 / QQ浏览器）。
2. 以 --app="http://127.0.0.1:<DSH端口>/?dsh_bar_clone=1" 启动真正的 DeepSeek Harness 原版 Web UI 分身（保留 100% 原版 CSS、+ 号、完全权限、模型与推理档位切换、语音输入与阴影特效，绝非山寨重绘！）。
3. 通过 Win32 API 剥离浏览器标题栏与厚边框 (WS_CAPTION | WS_THICKFRAME)，叠加 Windows 11 原生硬件抗锯齿大圆角与阴影 (DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND + SetWindowRgn 24px 圆角裁剪)，表面看是一个悬浮圆角气泡，底层是真正的原版浏览器。
4. 60Hz (16ms) 实时读取页面上报的 [DSH-BAR:宽x高]：
   - 鼠标移入上方 Agent 卡片或点开「完全权限 / 模型选择 / +」菜单时，气泡窗口底部锚定不动、顶部毫秒级向上丝滑扩容，绝不裁切弹窗；鼠标移开自动收回紧凑气泡高度；
   - 支持左右两侧边缘拖拽拉伸宽度；
   - 可选绑定目标窗口（如 --bind-process SLDWORKS.exe），仅在目标窗口前台时显示，并随目标窗口缩放与拖动 60Hz 居中跟随！
"""

from __future__ import annotations
import argparse
import ctypes
from ctypes import wintypes
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request


DSH_BAR_TAG_RE = re.compile(r"\[DSH-BAR:(\d+)x(\d+)\]")


def detect_chromium_browser() -> tuple[str, str]:
    """Detect installed Chromium-based browser in priority order: Edge -> Chrome -> Brave/Vivaldi/Chromium."""
    candidates: list[tuple[str, list[str]]] = [
        (
            "Microsoft Edge",
            [
                os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
                os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
                os.path.expandvars(r"%LocalAppData%\Microsoft\Edge\Application\msedge.exe"),
                shutil.which("msedge") or "",
            ],
        ),
        (
            "Google Chrome",
            [
                os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
                os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
                os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
                shutil.which("chrome") or "",
            ],
        ),
        (
            "Brave Browser",
            [
                os.path.expandvars(r"%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"),
                os.path.expandvars(r"%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe"),
            ],
        ),
        (
            "Vivaldi",
            [
                os.path.expandvars(r"%LocalAppData%\Vivaldi\Application\vivaldi.exe"),
                os.path.expandvars(r"%ProgramFiles%\Vivaldi\Application\vivaldi.exe"),
            ],
        ),
        (
            "Chromium / 国内双核浏览器",
            [
                os.path.expandvars(r"%LocalAppData%\Chromium\Application\chrome.exe"),
                os.path.expandvars(r"%LocalAppData%\360ChromeX\Chrome\Application\360ChromeX.exe"),
                os.path.expandvars(r"%ProgramFiles(x86)%\Tencent\QQBrowser\QQBrowser.exe"),
            ],
        ),
    ]

    for name, paths in candidates:
        for p in paths:
            if p and os.path.isfile(p):
                return name, p

    # Fallback: query Windows App Paths registry
    if os.name == "nt":
        import winreg

        for exe_key, label in [
            ("msedge.exe", "Microsoft Edge"),
            ("chrome.exe", "Google Chrome"),
            ("brave.exe", "Brave Browser"),
        ]:
            for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
                try:
                    with winreg.OpenKey(
                        root, rf"Software\Microsoft\Windows\CurrentVersion\App Paths\{exe_key}"
                    ) as k:
                        val, _ = winreg.QueryValueEx(k, "")
                        if val and os.path.isfile(val):
                            return label, val
                except OSError:
                    pass

    raise RuntimeError("未检测到 Edge / Chrome 或其他 Chromium 内核浏览器，请传入 --browser-exe 指定路径。")


def fetch_active_dsh_session_path(dsh_url: str) -> str:
    url = dsh_url.rstrip("/") + "/dsh-card-dock/state"
    try:
        with urllib.request.urlopen(url, timeout=1.2) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            sp = str(data.get("sessionPath") or "/")
            return sp if sp.startswith("/") else "/"
    except Exception:
        return "/"


def find_bubble_hwnd_win32() -> int:
    user32 = ctypes.windll.user32
    found_hwnd = 0
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def _cb(hwnd, _lparam):
        nonlocal found_hwnd
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value
        if "[DSH-BAR:" in title or "dsh_bar_clone=1" in title:
            found_hwnd = int(hwnd)
            return False
        return True

    cb_func = WNDENUMPROC(_cb)
    user32.EnumWindows(cb_func, 0)
    return found_hwnd


def find_target_host_hwnd(process_name: str, title_keyword: str) -> tuple[int, int]:
    """Find target application main window (e.g. SLDWORKS.exe / SOLIDWORKS) -> (hwnd, pid)."""
    if not process_name and not title_keyword:
        return 0, 0
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    best_hwnd = 0
    best_pid = 0
    best_area = 0
    proc_low = process_name.lower().strip()
    title_low = title_keyword.lower().strip()

    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def _cb(hwnd, _lparam):
        nonlocal best_hwnd, best_pid, best_area
        if not user32.IsWindowVisible(hwnd):
            return True
        pid_dw = wintypes.DWORD(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid_dw))
        pid = int(pid_dw.value)
        if not pid:
            return True

        matched = False
        if proc_low:
            hproc = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if hproc:
                try:
                    exe_buf = ctypes.create_unicode_buffer(512)
                    sz = wintypes.DWORD(512)
                    if kernel32.QueryFullProcessImageNameW(hproc, 0, exe_buf, ctypes.byref(sz)):
                        exe_base = os.path.basename(exe_buf.value).lower()
                        if exe_base == proc_low or proc_low in exe_base:
                            matched = True
                finally:
                    kernel32.CloseHandle(hproc)

        if not matched and title_low:
            tlen = user32.GetWindowTextLengthW(hwnd)
            if tlen > 0:
                tbuf = ctypes.create_unicode_buffer(tlen + 1)
                user32.GetWindowTextW(hwnd, tbuf, tlen + 1)
                if title_low in tbuf.value.lower():
                    matched = True

        if matched:
            r = wintypes.RECT()
            if user32.GetWindowRect(hwnd, ctypes.byref(r)):
                area = max(0, r.right - r.left) * max(0, r.bottom - r.top)
                if area > best_area and (r.right - r.left) >= 320:
                    best_area = area
                    best_hwnd = int(hwnd)
                    best_pid = pid
        return True

    cb_func = WNDENUMPROC(_cb)
    user32.EnumWindows(cb_func, 0)
    return best_hwnd, best_pid


def sculpt_frameless_rounded_bubble(hwnd: int, width_px: int, height_px: int, radius_px: int = 24) -> None:
    """Strip Chromium --app titlebar/borders and apply Windows 11 DWM rounded corners + 24px region mask."""
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    dwmapi = ctypes.windll.dwmapi

    GWL_STYLE = -16
    GWL_EXSTYLE = -20
    WS_CAPTION = 0x00C00000
    WS_THICKFRAME = 0x00040000
    WS_MINIMIZEBOX = 0x00020000
    WS_MAXIMIZEBOX = 0x00010000
    WS_SYSMENU = 0x00080000
    WS_POPUP = 0x80000000
    WS_VISIBLE = 0x10000000
    WS_EX_TOOLWINDOW = 0x00000080
    WS_EX_TOPMOST = 0x00000008

    cur_style = user32.GetWindowLongW(wintypes.HWND(hwnd), GWL_STYLE)
    clean_style = (cur_style & ~(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU)) | WS_POPUP | WS_VISIBLE
    if cur_style != clean_style:
        user32.SetWindowLongW(wintypes.HWND(hwnd), GWL_STYLE, clean_style)

    cur_ex = user32.GetWindowLongW(wintypes.HWND(hwnd), GWL_EXSTYLE)
    clean_ex = cur_ex | WS_EX_TOOLWINDOW | WS_EX_TOPMOST
    if cur_ex != clean_ex:
        user32.SetWindowLongW(wintypes.HWND(hwnd), GWL_EXSTYLE, clean_ex)

    # Windows 11 DWM native hardware rounded corners & shadow (DWMWA_WINDOW_CORNER_PREFERENCE = 38, DWMWCP_ROUND = 2)
    try:
        pref = ctypes.c_int(2)
        dwmapi.DwmSetWindowAttribute(wintypes.HWND(hwnd), 38, ctypes.byref(pref), ctypes.sizeof(pref))
    except Exception:
        pass

    # Apply exact 24px (diameter = 48px scaled by DPI) rounded region so outer border matches [data-composer-card] 1:1
    try:
        dpi = user32.GetDpiForWindow(wintypes.HWND(hwnd)) or 96
    except Exception:
        dpi = 96
    diam = max(24, int(round(radius_px * 2 * (dpi / 96.0))))
    rgn = gdi32.CreateRoundRectRgn(0, 0, width_px + 1, height_px + 1, diam, diam)
    user32.SetWindowRgn(wintypes.HWND(hwnd), rgn, True)


def read_reported_css_size(hwnd: int, default_w: int, default_h: int) -> tuple[int, int]:
    user32 = ctypes.windll.user32
    tlen = user32.GetWindowTextLengthW(wintypes.HWND(hwnd))
    if tlen > 0:
        buf = ctypes.create_unicode_buffer(tlen + 1)
        user32.GetWindowTextW(wintypes.HWND(hwnd), buf, tlen + 1)
        m = DSH_BAR_TAG_RE.search(buf.value)
        if m:
            return int(m.group(1)), int(m.group(2))
    return default_w, default_h


def main() -> None:
    parser = argparse.ArgumentParser(description="DeepSeek-Bar 100% 原版浏览器无头圆角气泡分身启动器 (v1.0.0)")
    parser.add_argument("--dsh-url", default="http://127.0.0.1:3000", help="DeepSeek Harness Web UI 地址（如 http://127.0.0.1:3000）")
    parser.add_argument("--browser-exe", default="", help="可选：手动指定 Edge/Chrome 可执行文件路径")
    parser.add_argument("--bind-process", default="", help="可选：绑定跟随的目标进程名（例如 SLDWORKS.exe），不传则桌面自由底部居中悬浮")
    parser.add_argument("--bind-title", default="", help="可选：绑定跟随的目标窗口标题关键字（例如 SOLIDWORKS）")
    parser.add_argument("--bottom-margin", type=int, default=26, help="距离宿主窗口底部的像素边距")
    args = parser.parse_args()

    if os.name != "nt":
        print("[提示] 当前为非 Windows 环境；Windows 11 真机运行本脚本将自动拉起 Edge/Chrome 无头圆角气泡。")
        sys.exit(0)

    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        pass

    if args.browser_exe and os.path.isfile(args.browser_exe):
        browser_name, browser_path = "Custom Chromium", args.browser_exe
    else:
        browser_name, browser_path = detect_chromium_browser()

    session_path = fetch_active_dsh_session_path(args.dsh_url)
    sep = "&" if "?" in session_path else "?"
    clone_url = f"{args.dsh_url.rstrip('/')}{session_path}{sep}dsh_bar_clone=1"

    profile_dir = os.path.join(
        os.environ.get("LOCALAPPDATA", os.path.expanduser("~")),
        "dsh_card_dock_bubble_profile_v1",
    )
    os.makedirs(profile_dir, exist_ok=True)

    launch_cmd = [
        browser_path,
        f"--app={clone_url}",
        f"--user-data-dir={profile_dir}",
        "--window-size=780,146",
        "--disable-features=Translate,msEdgeSidebarV2,HardwareMediaKeyHandling",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    print(f"[dsh-card-dock] 已检测到浏览器: {browser_name} ({browser_path})")
    print(f"[dsh-card-dock] 正在启动 100% 原版 DSH 分身气泡: {clone_url}")
    proc = subprocess.Popen(launch_cmd)

    user32 = ctypes.windll.user32
    bubble_hwnd = 0
    for _ in range(80):
        bubble_hwnd = find_bubble_hwnd_win32()
        if bubble_hwnd:
            break
        time.sleep(0.1)

    if not bubble_hwnd:
        print("[警告] 暂未捕获到 [DSH-BAR] 窗口标题（请确认 DSH 已安装 @local/dsh-card-dock 插件且端口正确）。")
        proc.wait()
        return

    bubble_pid_dw = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(wintypes.HWND(bubble_hwnd), ctypes.byref(bubble_pid_dw))
    bubble_pid = int(bubble_pid_dw.value)

    SWP_NOACTIVATE = 0x0010
    SWP_NOZORDER = 0x0004
    SWP_SHOWWINDOW = 0x0040
    SWP_HIDEWINDOW = 0x0080
    SWP_FRAMECHANGED = 0x0020

    css_w, css_h = 780, 146
    last_rect = (0, 0, 0, 0)
    owner_bound = 0

    print("[dsh-card-dock] 圆角无头浏览器气泡已就绪！60Hz 窗口锚定与双向分身同步运行中...")
    while user32.IsWindow(wintypes.HWND(bubble_hwnd)):
        try:
            dpi = user32.GetDpiForWindow(wintypes.HWND(bubble_hwnd)) or 96
        except Exception:
            dpi = 96
        scale = dpi / 96.0

        css_w, css_h = read_reported_css_size(bubble_hwnd, css_w, css_h)
        phys_w = int(round(css_w * scale))
        phys_h = int(round(css_h * scale))

        if args.bind_process or args.bind_title:
            target_hwnd, target_pid = find_target_host_hwnd(args.bind_process, args.bind_title)
            if not target_hwnd or user32.IsIconic(wintypes.HWND(target_hwnd)):
                user32.SetWindowPos(wintypes.HWND(bubble_hwnd), 0, 0, 0, 0, 0, SWP_HIDEWINDOW | SWP_NOACTIVATE | SWP_NOZORDER)
                time.sleep(0.05)
                continue

            fg = user32.GetForegroundWindow()
            fg_pid_dw = wintypes.DWORD(0)
            if fg:
                user32.GetWindowThreadProcessId(fg, ctypes.byref(fg_pid_dw))
            if int(fg_pid_dw.value) not in (target_pid, bubble_pid):
                user32.SetWindowPos(wintypes.HWND(bubble_hwnd), 0, 0, 0, 0, 0, SWP_HIDEWINDOW | SWP_NOACTIVATE | SWP_NOZORDER)
                time.sleep(0.04)
                continue

            if owner_bound != target_hwnd:
                try:
                    user32.SetWindowLongPtrW(wintypes.HWND(bubble_hwnd), -8, wintypes.HANDLE(target_hwnd))
                    owner_bound = target_hwnd
                except Exception:
                    pass

            cr = wintypes.RECT()
            pt = wintypes.POINT(0, 0)
            if user32.GetClientRect(wintypes.HWND(target_hwnd), ctypes.byref(cr)) and (cr.right - cr.left) > 200:
                user32.ClientToScreen(wintypes.HWND(target_hwnd), ctypes.byref(pt))
                host_x, host_y, host_w, host_h = pt.x, pt.y, cr.right - cr.left, cr.bottom - cr.top
            else:
                wr = wintypes.RECT()
                user32.GetWindowRect(wintypes.HWND(target_hwnd), ctypes.byref(wr))
                host_x, host_y, host_w, host_h = wr.left, wr.top, wr.right - wr.left, wr.bottom - wr.top

            final_w = min(phys_w, max(int(380 * scale), host_w - int(32 * scale)))
            final_h = min(phys_h, max(int(110 * scale), host_h - int(32 * scale)))
            pos_x = host_x + (host_w - final_w) // 2
            pos_y = host_y + host_h - int(args.bottom_margin * scale) - final_h
        else:
            # Desktop bottom-center floating bubble mode
            scr_w = user32.GetSystemMetrics(0)
            scr_h = user32.GetSystemMetrics(1)
            final_w = min(phys_w, scr_w - 48)
            final_h = phys_h
            pos_x = (scr_w - final_w) // 2
            pos_y = scr_h - int(68 * scale) - final_h

        next_rect = (pos_x, pos_y, final_w, final_h)
        if next_rect != last_rect:
            size_changed = (final_w, final_h) != (last_rect[2], last_rect[3])
            sculpt_frameless_rounded_bubble(bubble_hwnd, final_w, final_h, radius_px=24)
            flags = SWP_SHOWWINDOW | SWP_NOACTIVATE | (SWP_FRAMECHANGED if size_changed else 0)
            user32.SetWindowPos(wintypes.HWND(bubble_hwnd), -1, pos_x, pos_y, final_w, final_h, flags)
            last_rect = next_rect

        time.sleep(0.016)


if __name__ == "__main__":
    main()

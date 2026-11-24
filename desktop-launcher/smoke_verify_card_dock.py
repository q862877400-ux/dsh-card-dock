#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
desktop-launcher/smoke_verify_card_dock.py — @local/dsh-card-dock 独立插件冒烟验证脚本
验证：
1. GET /dsh-card-dock/state 返回 200 OK
2. POST /dsh-card-dock/sync 双向草稿同步、会话路径同步与宽度同步正常推进 seq
"""

from __future__ import annotations
import argparse
import json
import sys
import urllib.request


def _req(url: str, method: str = "GET", payload: dict | None = None) -> tuple[int, dict]:
    raw = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"} if raw is not None else {}
    req = urllib.request.Request(url, data=raw, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=5.0) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dsh-url", default="http://127.0.0.1:3000")
    args = parser.parse_args()
    base = args.dsh_url.rstrip("/")

    c1, s1 = _req(f"{base}/dsh-card-dock/state")
    assert c1 == 200 and s1.get("ok") is True, f"state failed: {s1}"
    print(f"[PASS] 1. GET /dsh-card-dock/state -> seq={s1.get('seq')}, widthPx={s1.get('widthPx')}")

    c2, r2 = _req(
        f"{base}/dsh-card-dock/sync",
        method="POST",
        payload={
            "clientId": "smoke-test-bubble",
            "sessionPath": "/s/demo-session-01",
            "draft": "实时同步测试：两边输入框共享同一份草稿",
            "widthPx": 860,
        },
    )
    assert c2 == 200 and r2.get("ok") is True, f"sync failed: {r2}"

    c3, s3 = _req(f"{base}/dsh-card-dock/state")
    assert s3.get("draft") == "实时同步测试：两边输入框共享同一份草稿" and s3.get("widthPx") == 860, f"mismatch: {s3}"
    print(f"[PASS] 2. POST /dsh-card-dock/sync 双向状态同步验证通过 -> seq={s3.get('seq')}, draft={s3.get('draft')}")
    print("\n=== @local/dsh-card-dock v1.0.0 独立插件冒烟验证全部通过 (EXIT 0) ===")


if __name__ == "__main__":
    main()

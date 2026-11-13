# -*- coding: utf-8 -*-
"""EA v3.06 account.trade_flags: the app says WHICH MT5 permission is off (the EA's Allow Algo Trading tick, the
toolbar button, an investor-password / disconnected login, the broker's EA ban) instead of always "press Algo
Trading". Older EAs (only trade_permitted) keep the old messages word for word."""
import json
import os
import re

import pytest

import dobby_app_core as core
from conftest import BOT

MQ5_306 = r"D:\Dobby\mt5\Dobby3_v306.mq5"
NOW = 1794002099.0
CFG = {"supabase_url": "https://x.supabase.co", "anon_key": "k", "refresh_token": "rt", "bot_id": BOT,
       "bot_name": "Main PC", "limits": {}, "app": {}}
SNAP = {"web_version": 4, "applied_version": 4, "rejected": [], "last_error": "", "last_ok_at": NOW - 4}

OLD_CHECK = "ติ๊ก Allow Algo Trading ในหน้าต่างของ Dobby และกดปุ่ม Algo Trading ให้เป็นสีเขียว"
OLD_HERO = "ปุ่ม Algo Trading ใน MT5 ยังไม่เปิด: กดให้เป็นสีเขียว"


def _st(permitted=False, flags=None, connected=True):
    with open(os.path.join(os.path.dirname(__file__), "fixtures", "dobby2_status.json"), encoding="utf-8") as f:
        st = json.load(f)
    st["heartbeat_gmt_unix"] = int(NOW) - 3
    st["account"] = dict(st["account"], trade_permitted=permitted, connected=connected)
    if flags is not None:
        st["account"]["trade_flags"] = flags
    return st


def _flags(**off):
    f = {"ea": True, "terminal": True, "account": True, "expert": True}
    f.update(off)
    return f


def _algo(st):
    return core.build_checklist(CFG, st, SNAP, NOW, running=True)[3]


def _hero(st):
    return core.hero_state(CFG, st, SNAP, NOW, True)


# ---------------------------------------------------------------------------------------------------------------------
# trade_block: which permission
# ---------------------------------------------------------------------------------------------------------------------
def test_trade_block_none_when_permitted():
    assert core.trade_block(_st(True)["account"]) is None
    assert core.trade_block(_st(True, _flags())["account"]) is None
    assert _algo(_st(True, _flags()))["state"] == "ok"


@pytest.mark.parametrize("off, key, steps", [
    ({"ea": False}, "ea", ["allow"]),
    ({"terminal": False}, "terminal", ["algo"]),
    ({"terminal": False, "ea": False}, "terminal_ea", ["allow", "algo"]),
    ({"account": False}, "account", []),
    ({"expert": False}, "expert", []),
    # login / broker first: no button helps until they are fixed
    ({"account": False, "terminal": False, "ea": False}, "account", []),
    ({"expert": False, "ea": False}, "expert", []),
    ({"account": False, "expert": False}, "account", []),
])
def test_trade_block_picks_the_permission(off, key, steps):
    b = core.trade_block(_st(False, _flags(**off))["account"])
    assert b["key"] == key
    assert [s[0] for s in b["steps"]] == steps


def test_account_off_while_disconnected_is_the_connection():
    b = core.trade_block(_st(False, _flags(account=False), connected=False)["account"])
    assert b["key"] == "connection" and "เชื่อมต่อ" in b["title"]


@pytest.mark.parametrize("acc", [
    {"trade_permitted": False},                                     # EA before v3.06
    {"trade_permitted": False, "trade_flags": _flags()},            # flags read a moment later: all on again
    {"trade_permitted": False, "trade_flags": "ea"},                # garbage
    {"trade_permitted": False, "trade_flags": [False, False]},
    {"trade_permitted": False, "trade_flags": {"ea": 0, "terminal": None}},   # only a real false counts
    {},                                                             # no trade_permitted at all (= not True)
    None,
])
def test_unknown_when_the_flags_do_not_say(acc):
    assert core.trade_block(acc)["key"] == "unknown"


# ---------------------------------------------------------------------------------------------------------------------
# what the user reads: readiness list (row 4) and the main status line
# ---------------------------------------------------------------------------------------------------------------------
def test_old_ea_keeps_todays_messages():
    st = _st(False)                                                 # no trade_flags
    it = _algo(st)
    assert (it["state"], it["title"], it["detail"]) == ("bad", "Algo Trading ยังไม่เปิด", OLD_CHECK)
    h = _hero(st)
    assert (h["tone"], h["title"], h["text"], h["action"], h["action_label"]) == (
        "warn", "รอ MT5", OLD_HERO, "algo_help", "ดูวิธีเปิด")


def test_ea_tick_off_says_f7_common_not_the_toolbar():
    st = _st(False, _flags(ea=False))
    it = _algo(st)
    assert it["state"] == "bad" and "Allow Algo Trading" in it["title"] and "Dobby" in it["title"]
    assert "F7" in it["detail"] and "Common" in it["detail"] and "แถบเครื่องมือเปิดแล้ว" in it["detail"]
    h = _hero(st)
    assert h["tone"] == "warn" and h["action"] == "algo_help" and "F7" in h["text"]
    assert h["text"] != OLD_HERO and "กดให้เป็นสีเขียว" not in h["text"]


def test_toolbar_button_off():
    st = _st(False, _flags(terminal=False))
    it = _algo(st)
    assert it["title"] == "ปุ่ม Algo Trading ยังไม่เปิด" and "แถบเครื่องมือ" in it["detail"] and "สีเขียว" in it["detail"]
    assert "F7" not in it["detail"]
    h = _hero(st)
    assert h["action"] == "algo_help" and "แถบเครื่องมือ" in h["text"] and "F7" not in h["text"]


def test_toolbar_and_tick_off_names_both():
    h = _hero(_st(False, _flags(terminal=False, ea=False)))
    assert "แถบเครื่องมือ" in h["text"] and "F7" in h["text"] and h["action"] == "algo_help"


def test_investor_password():
    st = _st(False, _flags(account=False))
    it = _algo(st)
    assert it["state"] == "bad" and "ดูได้อย่างเดียว" in it["title"]
    assert "รหัสผ่านนักลงทุน" in it["detail"] and "รหัสผ่านหลัก" in it["detail"] and "Login to Trade Account" in it["detail"]
    h = _hero(st)
    assert h["action"] is None and h["stamp"] == ("cinnabar", "ต้องแก้") and "รหัสผ่านหลัก" in h["text"]
    assert "Algo Trading" not in h["text"]


def test_broker_disallows_eas():
    st = _st(False, _flags(expert=False))
    it = _algo(st)
    assert "โบรก" in it["title"] and "ติดต่อโบรก" in it["detail"]
    h = _hero(st)
    assert h["action"] is None and "โบรก" in h["title"] and "Algo Trading" not in h["text"]


def test_disconnected_account():
    h = _hero(_st(False, _flags(account=False), connected=False))
    assert h["action"] is None and "เชื่อมต่อ" in h["title"] and "อินเทอร์เน็ต" in h["text"]
    assert h["stamp"] == ("cinnabar", "รอ MT5")


def test_permitted_v306_status_trades_normally():
    h = _hero(_st(True, _flags()))
    assert (h["tone"], h["title"]) == ("good", "Dobby กำลังเทรดจริง")


def test_every_message_is_thai_text():
    for key, (title, how, steps) in core.TRADE_BLOCK_TH.items():
        assert title and how and re.search(u"[\u0e00-\u0e7f]", title + how), key
        assert all(s in core.TRADE_HELP_STEPS for s in steps), key
    # the help-dialog pictures exist in the manual MT5 steps
    pics = set(k for k, _, _ in core.mt5_steps())
    assert all(v[0] in pics for v in core.TRADE_HELP_STEPS.values())


# ---------------------------------------------------------------------------------------------------------------------
# the fake EA (demo / selftest) can play a v3.06 status
# ---------------------------------------------------------------------------------------------------------------------
def test_demo_ea_writes_trade_flags_only_when_set(tmp_path):
    ea = core.DemoEA(str(tmp_path))
    assert "trade_flags" not in ea.status()["account"]              # v3.05 shape by default
    ea.trade_permitted = False
    ea.trade_flags = _flags(ea=False)
    acc = ea.status()["account"]
    assert acc["trade_flags"] == _flags(ea=False) and core.trade_block(acc)["key"] == "ea"


# ---------------------------------------------------------------------------------------------------------------------
# contract with the EA source (private, only on the owner's PC)
# ---------------------------------------------------------------------------------------------------------------------
@pytest.mark.skipif(not os.path.isfile(MQ5_306), reason="the private EA source is not on this PC")
def test_ea_v306_writes_the_four_flags():
    src = open(MQ5_306, encoding="utf-8", errors="replace").read()
    assert '#define EA_VERSION     "3.06"' in src
    assert '",\\"trade_flags\\":" + TradeFlagsJson()' in src
    assert '",\\"trade_permitted\\":" + B(TradingPermitted())' in src          # kept for older readers
    body = re.search(r"void TradeFlags\(([^)]*)\)\s*\{(.*?)\n  \}", src, re.S)
    assert body, "TradeFlags() not found"
    want = {"ea": "MQLInfoInteger(MQL_TRADE_ALLOWED)", "terminal": "TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)",
            "account": "AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)", "expert": "AccountInfoInteger(ACCOUNT_TRADE_EXPERT)"}
    for k, call in want.items():
        assert re.search(r"\b%s = g_tester \|\| %s != 0;" % (k, re.escape(call)), body.group(2)), k
    js = re.search(r"string TradeFlagsJson\(\)\s*\{(.*?)\n  \}", src, re.S).group(1)
    assert [m for m in re.findall(r'\\"(\w+)\\":', js)] == ["ea", "terminal", "account", "expert"]


@pytest.mark.skipif(not os.path.isfile(MQ5_306), reason="the private EA source is not on this PC")
def test_ea_v306_has_the_v305_inputs_so_the_web_preset_still_fits():
    src = open(MQ5_306, encoding="utf-8", errors="replace").read()
    found = re.findall(r"^input\s+\w+\s+(\w+)\s*=", src, re.M)
    assert found == [k for k, _, _ in core.EA_INPUTS]

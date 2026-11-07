# -*- coding: utf-8 -*-
"""Telegram: Thai message formatting, one message per event, rate limit, never raising."""
import os

import dobby_agent as da
from conftest import FIXTURES, Clock, FakeTelegramTransport

ROWS = da.read_journal_chunk(os.path.join(FIXTURES, "dobby2_journal.csv"), 0)[0]


def row(event, n=0):
    return [r for r in ROWS if r["event"] == event][n]


def test_journal_messages_in_thai():
    assert da.msg_journal("Main PC", row("OPEN")) == ("open", "[Main PC] เปิดออเดอร์ A_new SELL 0.03 lot @ 2514.16\n"
                                                              "SL 2520.16 | TP 2505.16\n"
                                                              "เวลาเซิร์ฟเวอร์ 2026.11.02 09:00:00")
    assert da.msg_journal("Main PC", row("CLOSE")) == ("close", "[Main PC] ปิดออเดอร์ A_new SELL 0.03 lot @ 2505.08 "
                                                                "(TP)\nกำไร +27.24 | virtual 307.24\n"
                                                                "เวลาเซิร์ฟเวอร์ 2026.11.02 09:20:07")
    assert da.msg_journal("Main PC", row("CLOSE", 2))[1].split("\n")[1] == "ขาดทุน -24.00 | virtual 283.26"
    assert da.msg_journal("Main PC", row("LOCK")) == (
        "lock", "[Main PC] ล็อกกำไร C5G SELL: เลื่อน SL ไป 2491.43\n"
                "gain 10.88 >= 95% of TP 11.45 -> SL 2491.43 locks about +31.95 (93%)")
    assert da.msg_journal("Main PC", row("LOCK1"))[1].startswith("[Main PC] ล็อกกำไร ขั้นที่ 1 C5G SELL: เลื่อน SL ไป 2492.37")
    assert da.msg_journal("Main PC", row("ERROR")) == (
        "error", "[Main PC] EA แจ้งข้อผิดพลาด (C5G): lock modify failed: retcode 10036 position closed\n"
                 "เวลาเซิร์ฟเวอร์ 2026.11.03 21:57:50")
    for ev in ("SKIP", "SIGNAL", "CONTROL", "START", "NEARTP", "DAYCAP"):
        assert da.msg_journal("Main PC", row(ev)) is None


def test_other_messages():
    assert da.msg_live("PC2", True, 17) == "[PC2] เปิดการเทรดจริงแล้ว (คำสั่งจากเว็บ v17)"
    assert da.msg_live("PC2", False, 18) == "[PC2] ปิดการเทรดจริงแล้ว: บอทหยุดเข้าออเดอร์ใหม่ (คำสั่งจากเว็บ v18)"
    assert da.msg_offline("PC2", None).startswith("[PC2] EA ออฟไลน์: ไม่พบไฟล์สถานะ")
    assert da.msg_test("PC2") == "[PC2] ทดสอบการแจ้งเตือนจาก Dobby agent %s สำเร็จ" % da.AGENT_VERSION
    assert "limits --allow-live on" in da.msg_live_refused("PC2", 3)


def make(clock=None, **kw):
    t = FakeTelegramTransport()
    return da.Telegram(t, "123456:TOKEN-abcdef", "42", clock=clock or Clock(), **kw), t


def test_disabled_or_filtered_events_are_not_queued():
    tg, t = make()
    tg.configure("", "42")
    assert tg.notify("open", "x") is False
    tg, t = make(events=["close"])
    assert tg.notify("open", "x") is False and tg.notify("close", "y") is True
    tg.flush()
    assert t.texts() == ["y"] and t.sent[0]["chat_id"] == "42"


def test_rate_limit_burst_and_per_minute():
    clock = Clock()
    tg, t = make(clock)
    for i in range(25):
        tg.notify("open", "m%d" % i)
    assert tg.flush() == 3                                       # a burst of at most 3 per cycle
    for _ in range(10):
        clock.advance(5)
        tg.flush()
    assert len(t.sent) == 20                                     # never more than 20 a minute
    clock.advance(5)
    tg.flush()
    assert len(t.sent) == 20                                     # the first 3 are only 55 s old
    clock.advance(6)
    tg.flush()
    assert t.texts()[:23] == ["m%d" % i for i in range(23)]      # order kept, nothing lost


def test_queue_overflow_drops_oldest_and_says_so():
    tg, t = make(queue_max=30)
    for i in range(35):
        tg.notify("open", "m%d" % i)
    tg.flush()
    assert t.texts()[0] == "(ข้ามข้อความเก่า 5 รายการ เพราะแจ้งเตือนถี่เกินไป)\nm5"
    assert t.texts()[1] == "m6"


def test_dedupe_key_cooldown():
    clock = Clock()
    tg, t = make(clock)
    assert tg.notify("error", "same", key="e1") is True
    assert tg.notify("error", "same", key="e1") is False
    clock.advance(1801)
    assert tg.notify("error", "same", key="e1") is True


def test_429_pauses_and_network_errors_never_raise():
    clock = Clock()
    tg, t = make(clock)
    tg.notify("open", "a")
    t.fail = 429
    assert tg.flush() == 0 and tg.pause_until == clock() + 7
    t.fail = None
    clock.advance(3)
    assert tg.flush() == 0                                       # still paused
    clock.advance(5)
    assert tg.flush() == 1
    t.fail = "network"
    tg.notify("open", "b")
    for _ in range(3):
        assert tg.flush() == 0                                   # no exception
    assert tg.queue == []                                        # dropped after 3 failures
    ok, info = tg.send_now("c")
    assert ok is False and "TOKEN-abcdef" not in info


def test_dry_run_never_sends():
    tg, t = make(dry_run=True)
    assert tg.notify("open", "x") is True
    assert tg.flush() == 0 and t.sent == []

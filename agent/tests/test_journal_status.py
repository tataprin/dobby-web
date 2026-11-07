# -*- coding: utf-8 -*-
"""Journal CSV parsing, line hashes, status file parsing and the server UTC offset."""
import hashlib
import json
import os
import shutil

import dobby_agent as da
from conftest import FIXTURES, OFFSET, load_fixture_status, utc

JOURNAL = os.path.join(FIXTURES, "dobby2_journal.csv")


def read_all(path, offset=0):
    rows, ends, off, reset = da.read_journal_chunk(path, offset, sleep=lambda s: None)
    return rows, ends, off, reset


# ---------------------------------------------------------------------------------------------------------------- journal
def test_journal_fixture_parses_every_row():
    rows, ends, off, reset = read_all(JOURNAL)
    assert len(rows) == 20 and not reset
    assert off == os.path.getsize(JOURNAL)
    assert [r["event"] for r in rows[:4]] == ["CONTROL", "START", "SIGNAL", "OPEN"]
    op = rows[3]
    assert op["ts_server"] == "2026-11-02T09:00:00"
    assert (op["tag"], op["side"], op["lots"], op["price"], op["sl"], op["tp"]) == ("A_new", "SELL", 0.03, 2514.16,
                                                                                  2520.16, 2505.16)
    assert (op["pnl"], op["v_balance"], op["step"]) == (0.0, 280.0, 0)
    close = rows[4]
    assert close["event"] == "CLOSE" and close["sl"] is None and close["tp"] is None and close["pnl"] == 27.24
    assert set(op) == set(da.JOURNAL_FIELDS[1:]) | {"ts_server", "line_hash"}


def test_journal_quoted_detail_with_commas_and_quotes():
    rows = read_all(JOURNAL)[0]
    start = [r for r in rows if r["event"] == "START"][0]
    assert start["detail"] == ("v3.03 A_new+NY+C5G lots 0.03/0.03/0.03 (max 0.03) virtual 280.00 since "
                               "2026.10.23 10:00:00, balance 280.00 | mode DEMO")
    skip = [r for r in rows if r["event"] == "SKIP"][0]
    assert skip["detail"].endswith("VWAP 2512.39 touched, close 2509.59, RSI hook 50.5->44.7")
    ctl = [r for r in rows if r["event"] == "CONTROL"][1]
    assert ctl["detail"].endswith('id=W017 note=web: NFP, then "CPI"')
    assert ctl["step"] == 0


def test_journal_half_written_last_line_is_left_for_later(tmp_path):
    p = str(tmp_path / "j.csv")
    with open(JOURNAL, "rb") as f:
        full = f.read()
    extra_line = b"2026.11.09 10:00:00,OPEN,C5G,BUY,0.03,2600.00,2594.00,2609.00,0.00,283.26,0,\"a, b\""
    with open(p, "wb") as f:
        f.write(full + extra_line[:30])                     # the EA is in the middle of writing the line
    rows, ends, off, _ = read_all(p)
    assert len(rows) == 20 and off == len(full)              # the partial line is not consumed
    with open(p, "ab") as f:
        f.write(extra_line[30:] + b"\r\n")
    rows2, ends2, off2, _ = read_all(p, off)
    assert len(rows2) == 1 and rows2[0]["detail"] == "a, b" and rows2[0]["event"] == "OPEN"
    assert off2 == os.path.getsize(p) and ends2 == [off2]


def test_journal_shrunk_file_is_reread_from_start(tmp_path):
    p = str(tmp_path / "j.csv")
    shutil.copy(JOURNAL, p)
    rows, ends, off, reset = read_all(p, os.path.getsize(JOURNAL) + 999)
    assert reset and len(rows) == 20


def test_journal_bad_line_skipped_and_header_ignored(tmp_path):
    p = str(tmp_path / "j.csv")
    with open(p, "wb") as f:
        f.write((da.JOURNAL_HEADER + "\r\ngarbage line\r\n2026.11.09 10:00:00,STOP,ALL,NONE,0.00,,,,0.00,1.00,0,x\r\n")
                .encode("utf-8"))
    rows = read_all(p)[0]
    assert [r["event"] for r in rows] == ["STOP"]


def test_line_hash_is_sha1_of_raw_line_and_stable(tmp_path):
    with open(JOURNAL, "rb") as f:
        raw_lines = f.read().split(b"\r\n")[1:-1]
    rows = read_all(JOURNAL)[0]
    assert [r["line_hash"] for r in rows] == [hashlib.sha1(x).hexdigest() for x in raw_lines]
    # same hashes whatever the chunking (read in two parts) and on every re-read
    p = str(tmp_path / "j.csv")
    with open(JOURNAL, "rb") as f:
        data = f.read()
    cut = data.index(b"\r\n", len(data) // 2) + 2 + 17       # middle of a line
    with open(p, "wb") as f:
        f.write(data[:cut])
    r1, _, off, _ = read_all(p)
    with open(p, "wb") as f:
        f.write(data)
    r2 = read_all(p, off)[0]
    assert [r["line_hash"] for r in r1 + r2] == [r["line_hash"] for r in rows]
    assert [r["line_hash"] for r in read_all(JOURNAL)[0]] == [r["line_hash"] for r in rows]
    assert da.line_hash("abc") == da.line_hash(b"abc") == hashlib.sha1(b"abc").hexdigest()


# ---------------------------------------------------------------------------------------------------------------- status
def test_status_fixture_parses():
    st = da.read_status_file(os.path.join(FIXTURES, "dobby2_status.json"))
    assert st["schema_version"] == 4 and st["ea_version"] == "3.03" and st["symbol"] == "XAUUSD"
    assert st["control"]["file_exists"] is False and st["flags"]["live_locked"] is False
    assert len(st["modules"]) == 4 and st["virtual"]["day_cap_hit"] is False


def test_status_mid_write_is_retried(tmp_path):
    p = str(tmp_path / "s.json")
    good = json.dumps(load_fixture_status())
    with open(p, "w", encoding="utf-8") as f:
        f.write(good[:200])                                  # caught mid-write
    calls = []

    def sleep(s):
        calls.append(s)
        with open(p, "w", encoding="utf-8") as f:
            f.write(good)

    st = da.read_status_file(p, sleep=sleep)
    assert st["symbol"] == "XAUUSD" and len(calls) == 1
    assert da.read_status_file(str(tmp_path / "missing.json")) is None


def test_status_still_broken_returns_none(tmp_path):
    p = str(tmp_path / "s.json")
    with open(p, "w") as f:
        f.write("{not json")
    assert da.read_status_file(p, sleep=lambda s: None) is None


def test_server_utc_offset_formula():
    # 2026.11.06 23:54:59 server time with the matching GMT heartbeat (21:54:59 UTC) -> UTC+120
    st = {"server_time": "2026.11.06 23:54:59", "heartbeat_gmt_unix": 1794002099}
    assert da.raw_offset_min(st) == 120
    assert da.raw_offset_min({"server_time": "2026.11.06 23:54:59", "heartbeat_gmt_unix": 1794002099 + 400}) == 120
    assert da.raw_offset_min({"server_time": "2026.07.01 12:00:00",
                              "heartbeat_gmt_unix": int(utc(2026, 7, 1, 9, 0, 0))}) == 180
    assert da.raw_offset_min({"server_time": "bad", "heartbeat_gmt_unix": 1}) is None
    assert da.raw_offset_min({"server_time": "2026.11.06 23:54:59"}) is None


def test_stale_weekend_status_does_not_change_a_confirmed_offset(tmp_path):
    """The real status file of 2026-11-07 (EA stopped on Saturday) has server_time 2026.11.06 23:54:59 (the last tick,
    frozen) and heartbeat 1794029630 (PC clock, 05:33:50 UTC): the plain formula gives -345, not 120. The agent only
    trusts the offset after two samples in which the server clock runs with the GMT clock."""
    stale = {"server_time": "2026.11.06 23:54:59", "heartbeat_gmt_unix": 1794029630}
    assert da.raw_offset_min(stale) == -345
    from conftest import Env
    e = Env(tmp_path)
    a = e.agent()
    hb = 1794002099
    a._track_offset({"server_time": "2026.11.06 23:54:59", "heartbeat_gmt_unix": hb})
    assert a.effective_offset() == (120, "unconfirmed")
    a._track_offset({"server_time": "2026.11.06 23:55:04", "heartbeat_gmt_unix": hb + 5})
    assert a.effective_offset() == (120, "confirmed")
    a._track_offset(stale)                                    # weekend: frozen server clock
    a._track_offset(dict(stale, heartbeat_gmt_unix=1794029635))
    assert a.effective_offset() == (120, "confirmed")
    # a fresh agent that only ever saw the frozen clock: unconfirmed, and never uploaded as bots.server_utc_offset_min
    e2 = Env(tmp_path / "second")
    b = e2.agent()
    b._track_offset(stale)
    b._track_offset(dict(stale, heartbeat_gmt_unix=1794029635))
    assert b.effective_offset() == (-345, "unconfirmed")
    # config override wins
    da.update_config(e2.cfg_path, lambda c: c.__setitem__("server_utc_offset_min", 120))
    b.reload_config()
    assert b.effective_offset() == (120, "config")


def test_offset_confirmed_in_the_loop_and_uploaded(env):
    a = env.agent()
    a.cycle()
    assert "server_utc_offset_min" not in env.fake.bots_patches[-1]   # one sample: not trusted yet
    assert "offset_unconfirmed" in env.fake.bots_patches[-1]["agent_state"]["warnings"]
    env.tick(31)
    a.cycle()
    assert env.fake.bots_patches[-1]["server_utc_offset_min"] == OFFSET
    assert env.fake.bots_patches[-1]["agent_state"]["offset_source"] == "confirmed"
    assert env.state()["offset"]["confirmed"] is True

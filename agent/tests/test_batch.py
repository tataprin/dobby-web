# -*- coding: utf-8 -*-
"""Agent 1.2.0, feature batch 2026-11-07 (SPEC 9): bars upload (9.1), deposit / withdrawal suggestions (9.2),
automatic blackouts from the ForexFactory week, a weekly schedule and NYSE holidays (9.3). Offline only: fake
Supabase, fake ForexFactory transport, temp folders, fake clock (T0 = Monday 2026-11-09 08:00 UTC)."""
import json
import os
from datetime import date

import pytest

import dobby_agent as da
from conftest import BOT, Env, FakeNewsTransport, server_time_str, utc

HEADER = "bar_time,decision_time,close,rsi,atr,sl_dist,h4_close,h4_ema,h4_ema_prev,trend,bull,bear,signal,note\r\n"


def bar_line(t_utc, close, vwap=None, offset=120):
    s = server_time_str(t_utc, offset)
    base = "%s,%s,%.2f,51.0,6.5,6.0,4060.0,4032.0,4030.0,1,0,0,0," % (s, s, close)
    return base + ("" if vwap is None else ",%.3f,0,none: outside order window" % vwap) + "\r\n"


def write_bars(e, start, n, mode="w", close0=4000.0):
    with open(e.path(da.BARS_NAME), mode + "b") as f:
        if mode == "w":
            f.write(HEADER.encode())
        for i in range(n):
            f.write(bar_line(start + i * 900, close0 + i * 0.25, 3990.0 + i * 0.1 if i % 2 else None).encode())


def lines(e):
    return e.read(da.CONTROL_NAME).decode("utf-8").split("\r\n")


def blackouts(e):
    return [ln[len("blackout="):] for ln in lines(e) if ln.startswith("blackout=")]


def ast(e):
    return e.fake.bots_patches[-1]["agent_state"]


# ======================================================================================================== 9.1 bars
def test_bars_first_upload_backfills_45_days_in_batches_of_500(tmp_path):
    e = Env(tmp_path, config_extra={"server_utc_offset_min": 120})
    start = e.clock() - 50 * 86400
    write_bars(e, start, 50 * 96)                                    # 50 days of M15 bars up to now
    a = e.agent()
    a.cycle()
    f = e.fake
    assert sum(f.bars_posts) == 45 * 96 and all(n <= 500 for n in f.bars_posts) and f.bars_posts[0] == 500
    ts = sorted(da.parse_utc(t) for t in f.bars)
    assert ts[0] >= e.clock() - 45 * 86400 and ts[-1] == start + (50 * 96 - 1) * 900
    last = f.bars[da.iso_z(ts[-1])]
    assert last["close"] == round(4000.0 + (50 * 96 - 1) * 0.25, 2) and last["vwap"] == round(3990.0 + 4799 * 0.1, 3)
    assert f.bars[da.iso_z(ts[-2])]["vwap"] is None                 # no vwap column -> null
    # server time 10:00 (UTC+2) is stored as 08:00 UTC
    assert da.iso_z(ts[-1]) == da.iso_z(e.clock() - 900)
    st = e.state()["bars_upload"]
    assert st["last_t"] == ts[-1] and st["pos"] == os.path.getsize(e.path(da.BARS_NAME))
    assert "bars_upload_failed" not in ast(e)["warnings"]


def test_bars_incremental_no_reupload_and_a_half_written_line_waits(tmp_path):
    e = Env(tmp_path, config_extra={"server_utc_offset_min": 120})
    write_bars(e, e.clock() - 10 * 900, 10)
    a = e.agent()
    a.cycle()
    assert e.fake.bars_posts == [10]
    e.tick(5)
    a.cycle()
    assert e.fake.bars_posts == [10]                                 # nothing new: no POST at all
    write_bars(e, e.clock(), 2, mode="a")
    with open(e.path(da.BARS_NAME), "ab") as f:
        f.write(bar_line(e.clock() + 1800, 4100.0).encode()[:20])   # the EA is still writing this line
    e.tick(5)
    a.cycle()
    assert e.fake.bars_posts == [10, 2]
    b = e.agent()                                                    # restart: state on disk, nothing re-sent
    e.tick(5)
    b.cycle()
    assert e.fake.bars_posts == [10, 2]
    with open(e.path(da.BARS_NAME), "ab") as f:
        f.write(bar_line(e.clock() + 1800, 4100.0).encode()[20:])   # ... and finished
    e.tick(5)
    b.cycle()
    assert e.fake.bars_posts == [10, 2, 1] and len(e.fake.bars) == 13


def test_bars_wait_for_a_confirmed_offset(tmp_path):
    e = Env(tmp_path)                                                # no configured offset
    write_bars(e, e.clock() - 4 * 900, 4)
    a = e.agent()
    a.cycle()                                                        # one status sample: offset not confirmed yet
    assert e.fake.bars_posts == [] and e.state()["bars_upload"]["pos"] == 0
    e.tick(5)                                                        # the server clock runs: offset confirmed
    a.cycle()
    assert e.fake.bars_posts == [4]
    assert sorted(e.fake.bars)[0] == da.iso_z(e.clock() - 5 - 4 * 900)


def test_bars_rewritten_file_only_newer_bars_are_sent(tmp_path):
    e = Env(tmp_path, config_extra={"server_utc_offset_min": 120})
    write_bars(e, e.clock() - 8 * 900, 8)
    a = e.agent()
    a.cycle()
    e.clock.advance(1800)
    write_bars(e, e.clock() - 4 * 900, 4)                            # rewritten, shorter: the last 4 bars
    e.write_status()
    a.cycle()
    assert e.fake.bars_posts == [8, 2] and len(e.fake.bars) == 10


def test_bars_missing_table_never_blocks_the_agent_and_is_retried_later(tmp_path):
    e = Env(tmp_path, config_extra={"server_utc_offset_min": 120})
    write_bars(e, e.clock() - 3 * 900, 3)
    e.fake.missing_tables.add("bars")                               # schema.sql not re-run yet
    a = e.agent()
    a.cycle()
    assert e.read(da.CONTROL_NAME) is not None and e.state()["applied_version"] == 1
    assert a.last_error == "" and "bars_upload_failed" in ast(e)["warnings"]
    posts = lambda: len([c for c in e.fake.rest_calls("POST") if c["url"].endswith("/bars")])  # noqa: E731
    assert posts() == 1
    e.fake.missing_tables.clear()
    e.tick(60)
    a.cycle()
    assert posts() == 1                                              # waits 10 minutes before the next try
    e.tick(da.API_RETRY_S)
    e.fake.bots_patches.clear()
    a.cycle()
    assert e.fake.bars_posts == [3]
    a._force_bots = True
    e.tick(5)
    a.cycle()
    assert "bars_upload_failed" not in ast(e)["warnings"]


def test_bars_dry_run_uploads_nothing(tmp_path):
    e = Env(tmp_path, config_extra={"server_utc_offset_min": 120})
    write_bars(e, e.clock() - 3 * 900, 3)
    a = e.agent(dry_run=True)
    a.cycle()
    assert e.fake.bars_posts == []


# ================================================================================================= 9.2 cash flows
def set_balance(e, bal, seconds=5):
    e.status["account"] = dict(e.status["account"], balance=bal)
    e.tick(seconds)


def append_close(e, pnl, minute=5):
    with open(e.path(da.JOURNAL_NAME), "ab") as f:
        f.write(("2026.11.09 10:%02d:00,CLOSE,C5G,BUY,0.10,4121.78,,,%.2f,363.20,0,reason=LOCK pos=4123\r\n"
                 % (minute, pnl)).encode())


def test_cash_step_pure():
    c = {"balance": None, "pnl": 0.0, "pending": None}
    assert da.cash_step(c, 500.0, 0) is None and c["balance"] == 500.0
    assert da.cash_step(c, None, 1) is None and c["balance"] == 500.0   # no fresh status: nothing changes
    assert da.cash_step(c, 509.99, 5) is None and c["balance"] == 509.99  # < 10: just a new baseline
    assert da.cash_step(c, 709.99, 10) is None and c["pending"]["amount"] == 200.0
    assert da.cash_step(c, 709.99, 15) is None                          # one cycle later, but < 15 s
    assert da.cash_step(c, 709.99, 25) == 200.0
    assert da.cash_threshold(5000) == 25.0 and da.cash_threshold(300) == 10.0
    c = {"balance": 5000.0, "pnl": 0.0, "pending": None}
    assert da.cash_step(c, 5020.0, 0) is None and c["pending"] is None    # 0.4 % < 0.5 %
    c = {"balance": 5000.0, "pnl": 0.0, "pending": None}
    assert da.cash_step(c, 5030.0, 0) is None and da.cash_step(c, 5030.0, 20) == 30.0


def test_deposit_is_suggested_once_after_it_stays_unexplained(env):
    a = env.agent()
    a.cycle()                                                        # baseline = 500
    assert env.state()["cash"]["balance"] == 500.0
    set_balance(env, 700.0)
    a.cycle()
    assert env.fake.cash_rows == [] and env.state()["cash"]["pending"]["amount"] == 200.0
    for _ in range(4):
        env.tick(5)
        a.cycle()
    assert len(env.fake.cash_rows) == 1
    r = env.fake.cash_rows[0]
    assert r == {"bot_id": BOT, "ts": r["ts"], "amount": 200.0, "source": "auto", "status": "suggested",
                 "balance_after": 700.0, "note": "balance change not explained by Dobby trades"}
    assert da.parse_utc(r["ts"]) == env.clock() - 5                # 15 s after it was first seen
    assert env.state()["cash"] == {"balance": 700.0, "pnl": 0.0, "pending": None}


def test_withdrawal_is_negative(env):
    a = env.agent()
    a.cycle()
    set_balance(env, 300.0)
    a.cycle()
    env.tick(20)
    a.cycle()
    assert [r["amount"] for r in env.fake.cash_rows] == [-200.0]


def test_a_close_row_one_cycle_after_the_balance_explains_it(env):
    a = env.agent()
    a.cycle()
    set_balance(env, 583.2)                                          # the balance first ...
    a.cycle()
    append_close(env, 83.2)                                          # ... the CLOSE row a cycle later
    env.tick(5)
    a.cycle()
    for _ in range(5):
        env.tick(5)
        a.cycle()
    assert env.fake.cash_rows == [] and env.state()["cash"] == {"balance": 583.2, "pnl": 0.0, "pending": None}


def test_a_close_row_before_the_balance_explains_it_too(env):
    a = env.agent()
    a.cycle()
    append_close(env, -45.5)
    env.tick(5)
    a.cycle()
    assert env.state()["cash"]["pending"]["amount"] == 45.5
    set_balance(env, 454.5)
    a.cycle()
    env.tick(30)
    a.cycle()
    assert env.fake.cash_rows == []


def test_deposit_together_with_a_trade_suggests_only_the_deposit(env):
    a = env.agent()
    a.cycle()
    append_close(env, 20.0)
    set_balance(env, 620.0)                                          # +20 trade, +100 deposit
    a.cycle()
    env.tick(20)
    a.cycle()
    assert [r["amount"] for r in env.fake.cash_rows] == [100.0]


def test_small_changes_and_an_offline_ea_are_ignored(env):
    a = env.agent()
    a.cycle()
    set_balance(env, 509.0)
    a.cycle()
    env.tick(20)
    a.cycle()
    assert env.fake.cash_rows == []
    env.status["account"] = dict(env.status["account"], balance=900.0)
    env.write_status(fresh=False)                                    # the old heartbeat: the EA is offline
    env.clock.advance(600)
    a.cycle()
    env.clock.advance(60)
    a.cycle()
    assert env.fake.cash_rows == [] and env.state()["cash"]["balance"] == 509.0


def test_cash_flow_table_missing_retries_later_and_keeps_the_suggestion(env):
    env.fake.missing_tables.add("cash_flows")
    a = env.agent()
    a.cycle()
    set_balance(env, 800.0)
    a.cycle()
    env.tick(20)
    a.cycle()
    assert env.fake.cash_rows == [] and a.last_error == ""
    a._force_bots = True
    env.tick(5)
    a.cycle()
    assert "cash_flow_failed" in ast(env)["warnings"]
    env.fake.missing_tables.clear()
    env.tick(da.API_RETRY_S)
    a.cycle()
    assert [r["amount"] for r in env.fake.cash_rows] == [300.0]


def test_cash_flows_dry_run_inserts_nothing(env):
    a = env.agent(dry_run=True)
    a.cycle()
    set_balance(env, 800.0)
    a.cycle()
    env.tick(20)
    a.cycle()
    assert env.fake.cash_rows == []


# ======================================================================================== 9.3 automatic blackouts
FF_WEEK = [
    {"title": "Non-Farm Employment Change", "country": "USD", "date": "2026-11-06T08:30:00-05:00", "impact": "High",
     "forecast": "65K", "previous": "29K"},
    {"title": "CPI m/m", "country": "USD", "date": "2026-11-10T08:30:00-05:00", "impact": "High",
     "forecast": "0.3%", "previous": "0.4%"},
    {"title": "German ZEW Economic Sentiment", "country": "EUR", "date": "2026-11-10T05:00:00-05:00",
     "impact": "Medium", "forecast": "", "previous": "39.3"},
    {"title": "Unemployment Claims", "country": "USD", "date": "2026-11-12T08:30:00-05:00", "impact": "High",
     "forecast": "221K", "previous": "219K"},
    {"title": "PPI m/m", "country": "USD", "date": "2026-11-12T08:30:00-05:00", "impact": "High",
     "forecast": "0.2%", "previous": "0.1%"},
    {"title": "Retail Sales m/m", "country": "USD", "date": "2026-11-12T10:00:00-05:00", "impact": "High",
     "forecast": "0.5%", "previous": "0.6%"},
    {"title": "broken", "country": "USD", "date": "not a date", "impact": "High"},
]
AUTO_NEWS = {"enabled": True, "before_min": 30, "after_min": 60, "currencies": ["USD"], "impact": ["High"]}
FRIDAY_NIGHT = {"enabled": True, "us_holidays": True, "weekly": [{"dow": 5, "from": "21:00", "to": "24:00"}]}
MANUAL = {"from_utc": "2026-11-11T13:00:00Z", "to_utc": "2026-11-11T14:00:00Z", "label": "web"}


def auto_desired(auto_news=AUTO_NEWS, schedule=FRIDAY_NIGHT, manual=(MANUAL,), live=False):
    d = {"live": live, "control": {"mode": "run", "lots": 0.03, "allow_long": True, "allow_short": True,
                                   "max_spread": None, "note": ""},
         "blackouts": [dict(b) for b in manual], "params": None}
    if auto_news is not None:
        d["auto_news"] = auto_news
    if schedule is not None:
        d["schedule"] = schedule
    return d


def auto_env(tmp_path, **kw):
    e = Env(tmp_path, desired=auto_desired(**kw), config_extra={"server_utc_offset_min": 120})
    news = FakeNewsTransport(FF_WEEK)
    return e, news


def test_auto_windows_are_written_with_the_manual_ones_and_reported(tmp_path):
    e, news = auto_env(tmp_path)
    a = e.agent(news=news)
    a.cycle()
    assert len(news.calls) == 1
    assert news.calls[0]["headers"]["User-Agent"] == "DobbyAgent/1.2" and news.calls[0]["timeout"] == 15
    # server time = UTC+2: CPI 13:30 UTC -> 15:00-16:30; claims + PPI 13:30 and retail sales 15:00 overlap -> one
    # window; Friday 21:00-24:00 Thai = 14:00-17:00 UTC = 16:00-19:00 server; the manual web window stays as it is
    assert blackouts(e) == ["2026.11.10 15:00-16:30", "2026.11.11 15:00-16:00", "2026.11.12 15:00-18:00",
                            "2026.11.13 16:00-19:00"]
    s = ast(e)
    assert s["auto_blackouts"] == [
        {"from_utc": "2026-11-10T13:00:00Z", "to_utc": "2026-11-10T14:30:00Z", "reason": "CPI m/m", "kinds": ["news"]},
        {"from_utc": "2026-11-12T13:00:00Z", "to_utc": "2026-11-12T16:00:00Z",
         "reason": "PPI m/m, Unemployment Claims, Retail Sales m/m", "kinds": ["news"]},
        {"from_utc": "2026-11-13T14:00:00Z", "to_utc": "2026-11-13T17:00:00Z", "reason": "ตารางเวลา",
         "kinds": ["schedule"]}]
    assert [n["title"] for n in s["news"]] == ["Non-Farm Employment Change", "CPI m/m", "PPI m/m",
                                               "Unemployment Claims", "Retail Sales m/m"]
    assert s["news"][1] == {"title": "CPI m/m", "ts_utc": "2026-11-10T13:30:00Z", "currency": "USD",
                            "impact": "High", "forecast": "0.3%", "previous": "0.4%"}
    assert s["news_fetched_at"] == da.iso_z(e.clock()) and "news_error" not in s
    assert e.fake.control_patches == [] and e.fake.control["desired"]["blackouts"] == [MANUAL]   # never synced back
    cache = json.load(open(os.path.join(e.agent_dir, da.NEWS_CACHE_NAME), encoding="utf-8"))
    assert cache["fetched_at"] == e.clock() and len(cache["events"]) == 6
    with open(os.path.join(e.agent_dir, da.DECISIONS_NAME), encoding="utf-8") as fh:
        assert "blackouts=4 (auto 3)" in fh.read()


def test_news_is_fetched_at_most_every_4_hours_and_the_last_good_copy_survives_errors(tmp_path):
    e, news = auto_env(tmp_path, schedule=None, manual=())
    a = e.agent(news=news)
    a.cycle()
    for _ in range(3):
        e.tick(3600)
        a.cycle()
    assert len(news.calls) == 1                                      # 3 h later: still the cached copy
    news.fail = 503
    e.tick(3600 + 5)
    a.cycle()
    assert len(news.calls) == 2
    s = ast(e)
    assert s["news_error"].startswith("ValueError: HTTP 503") and s["news_fetched_at"] == da.iso_z(utc(2026, 11, 9, 8))
    assert "2026.11.10 15:00-16:30" in blackouts(e)                  # the last good copy still protects
    e.tick(600)
    a.cycle()
    assert len(news.calls) == 2                                      # retry after 30 min, not every cycle
    news.fail = "html"                                               # ForexFactory's "Request Denied" page
    e.tick(1800)
    a.cycle()
    assert len(news.calls) == 3 and "JSONDecodeError" in ast(e)["news_error"]
    news.fail = None
    e.tick(1800)
    a.cycle()
    assert len(news.calls) == 4 and "news_error" not in ast(e)
    # a restarted agent uses the cached copy: no fetch for 4 h
    b = e.agent(news=news)
    e.tick(5)
    b.cycle()
    assert len(news.calls) == 4 and "2026.11.12 15:00-18:00" in blackouts(e)


def test_no_copy_yet_and_the_network_is_down(tmp_path):
    e, news = auto_env(tmp_path, schedule=None, manual=())
    news.fail = "network"
    a = e.agent(news=news)
    a.cycle()
    s = ast(e)
    assert s["news"] == [] and s["auto_blackouts"] == [] and "NetworkError" in s["news_error"]
    assert "news_fetched_at" not in s and blackouts(e) == [] and a.last_error == ""


def test_past_windows_are_dropped_and_the_file_rewritten(tmp_path):
    e, news = auto_env(tmp_path, schedule=None, manual=())
    a = e.agent(news=news)
    a.cycle()
    assert blackouts(e)[0] == "2026.11.10 15:00-16:30"
    e.clock.t = utc(2026, 11, 10, 14, 31)
    e.write_status()
    a.cycle()
    assert blackouts(e) == ["2026.11.12 15:00-18:00"]
    assert ast(e)["auto_blackouts"][0]["from_utc"] == "2026-11-12T13:00:00Z"


def test_auto_lines_are_never_adopted_into_desired_blackouts(tmp_path):
    e, news = auto_env(tmp_path)
    a = e.agent(news=news)
    a.cycle()
    text = e.read(da.CONTROL_NAME).decode("utf-8")
    local = text.replace("id=W001", "id=C001").replace("allow_short=1", "allow_short=0")
    local = local.replace("blackout=2026.11.13 16:00-19:00",
                          "blackout=2026.11.13 16:00-19:00\r\nblackout=2026.11.14 10:00-11:00")
    p = e.path(da.CONTROL_NAME)
    with open(p, "w", encoding="utf-8", newline="") as f:          # monitor/dobby2_control.py keeps every line
        f.write(local)
    t = os.stat(p).st_mtime + 5
    os.utime(p, (t, t))
    e.tick(5)
    a.cycle()
    assert len(e.fake.control_patches) == 1
    new = e.fake.control_patches[0]["body"]["desired"]
    assert new["blackouts"] == [MANUAL, {"from_utc": "2026-11-14T08:00:00Z", "to_utc": "2026-11-14T09:00:00Z",
                                         "label": "local"}]
    assert new["control"]["allow_short"] is False
    assert new["auto_news"] == AUTO_NEWS and new["schedule"] == FRIDAY_NIGHT       # kept as the web set them
    # re-applied as v2: the automatic lines are back in our own W file, next to the two manual ones
    assert b"id=W002" in e.read(da.CONTROL_NAME)
    assert blackouts(e) == ["2026.11.10 15:00-16:30", "2026.11.11 15:00-16:00", "2026.11.12 15:00-18:00",
                            "2026.11.13 16:00-19:00", "2026.11.14 10:00-11:00"]


def test_a_manual_window_equal_to_an_auto_one_survives_adoption(tmp_path):
    same = {"from_utc": "2026-11-10T13:00:00Z", "to_utc": "2026-11-10T14:30:00Z", "label": "CPI"}
    e, news = auto_env(tmp_path, schedule=None, manual=(same,))
    a = e.agent(news=news)
    a.cycle()
    assert blackouts(e) == ["2026.11.10 15:00-16:30", "2026.11.12 15:00-18:00"]
    local = e.read(da.CONTROL_NAME).decode("utf-8").replace("id=W001", "id=C002").replace("lots=0.03", "lots=0.02")
    p = e.path(da.CONTROL_NAME)
    with open(p, "w", encoding="utf-8", newline="") as f:
        f.write(local)
    t = os.stat(p).st_mtime + 5
    os.utime(p, (t, t))
    e.tick(5)
    a.cycle()
    assert e.fake.control_patches[0]["body"]["desired"]["blackouts"] == [same]


def test_us_holiday_window_near_thanksgiving(tmp_path):
    e = Env(tmp_path, desired=auto_desired(auto_news=None, schedule={"enabled": True, "us_holidays": True},
                                           manual=()), config_extra={"server_utc_offset_min": 120})
    e.clock.t = utc(2026, 11, 23, 8)
    e.write_status()
    a = e.agent(news=FakeNewsTransport([]))
    a.cycle()
    assert blackouts(e) == ["2026.11.26 07:00-2026.11.27 07:00"]   # 00:00-24:00 New York (EST) in server time
    assert ast(e)["auto_blackouts"] == [{"from_utc": "2026-11-26T05:00:00Z", "to_utc": "2026-11-27T05:00:00Z",
                                         "reason": "Thanksgiving Day", "kinds": ["holiday"]}]
    assert "news" not in ast(e)


def test_invalid_settings_are_ignored_with_a_warning(tmp_path):
    e, news = auto_env(tmp_path, auto_news=dict(AUTO_NEWS, before_min=300, currencies="USD"),
                       schedule={"enabled": True, "weekly": [{"dow": 8, "from": "21:00", "to": "24:00"},
                                                             {"dow": 5, "from": "23:00", "to": "22:00"},
                                                             {"dow": 6, "from": "00:00", "to": "02:00"}]},
                       manual=())
    a = e.agent(news=news)
    a.cycle()
    w = ast(e)["warnings"]
    assert "auto_news_invalid" in w and "schedule_invalid" in w
    # before_min 300 ignored (default 30); only the valid Saturday window (00:00-02:00 Thai = Fri 17:00-19:00 UTC)
    assert blackouts(e) == ["2026.11.10 15:00-16:30", "2026.11.12 15:00-18:00", "2026.11.13 19:00-21:00"]


def test_enabled_must_be_true_and_off_means_no_fetch_no_keys(tmp_path):
    e, news = auto_env(tmp_path, auto_news={"enabled": "yes"}, schedule={"enabled": False}, manual=())
    a = e.agent(news=news)
    a.cycle()
    s = ast(e)
    assert news.calls == [] and blackouts(e) == [] and "auto_blackouts" not in s and "news" not in s
    assert s["warnings"] == ["auto_news_invalid"]
    e2 = Env(tmp_path / "b")                                        # no auto keys at all: exactly as agent 1.1
    a2 = e2.agent(news=FakeNewsTransport(FF_WEEK))
    a2.cycle()
    assert "auto_blackouts" not in ast(e2) and ast(e2)["warnings"] == ["offset_unconfirmed"]


def test_unknown_offset_writes_no_auto_line(tmp_path):
    e = Env(tmp_path, desired=auto_desired(manual=()))
    e.write_status(server_time="garbage")
    news = FakeNewsTransport(FF_WEEK)
    a = e.agent(news=news)
    a.cycle()
    assert blackouts(e) == [] and "offset_unknown" in ast(e)["warnings"] and len(ast(e)["auto_blackouts"]) == 3


def test_remote_control_off_writes_nothing_even_with_auto_windows(tmp_path):
    e = Env(tmp_path, desired=auto_desired(), limits={"allow_remote_control": False},
            config_extra={"server_utc_offset_min": 120})
    a = e.agent(news=FakeNewsTransport(FF_WEEK))
    a.cycle()
    assert e.read(da.CONTROL_NAME) is None and ast(e)["rejected"] == ["remote_control_disabled"]


def test_live_is_untouched_by_auto_blackouts(tmp_path):
    e, news = auto_env(tmp_path)
    a = e.agent(news=news)
    a.cycle()
    assert "mode=pause" in lines(e)                                  # live false -> pause, as always
    assert e.fake.control_patches == []


def test_without_a_news_transport_the_supabase_transport_is_used_and_fails_safely(tmp_path):
    e = Env(tmp_path, desired=auto_desired(schedule=None, manual=()), config_extra={"server_utc_offset_min": 120})
    a = e.agent()                                                    # the fake Supabase refuses other hosts
    a.cycle()
    assert a.last_error == "" and "news_error" in ast(e) and blackouts(e) == []


# ----------------------------------------------------------------------------------------------- pure functions
def test_validate_auto_news_bounds():
    assert da.validate_auto_news(None) == (None, [])
    assert da.validate_auto_news({"enabled": False}) == (None, [])
    assert da.validate_auto_news([]) == (None, ["auto_news_invalid"])
    cfg, w = da.validate_auto_news({"enabled": True})
    assert cfg == {"before_min": 30, "after_min": 60, "currencies": ["USD"], "impact": ["High"]} and w == []
    cfg, w = da.validate_auto_news({"enabled": True, "before_min": 0, "after_min": 240, "currencies": ["usd", "EUR"],
                                    "impact": ["medium", "High"]})
    assert cfg == {"before_min": 0, "after_min": 240, "currencies": ["EUR", "USD"], "impact": ["High", "Medium"]}
    for bad in ({"before_min": -1}, {"after_min": 241}, {"before_min": True}, {"before_min": "30"},
                {"before_min": 12.5}, {"currencies": []}, {"currencies": ["US"]}, {"impact": ["Huge"]}):
        cfg, w = da.validate_auto_news(dict(bad, enabled=True))
        assert w == ["auto_news_invalid"] and cfg is not None, bad


def test_validate_schedule_bounds():
    assert da.validate_schedule({"enabled": True}) == ({"us_holidays": False, "weekly": []}, [])
    cfg, w = da.validate_schedule({"enabled": True, "us_holidays": True,
                                   "weekly": [{"dow": 7, "from": "22:00", "to": "24:00"}]})
    assert cfg == {"us_holidays": True, "weekly": [{"dow": 7, "from": 1320, "to": 1440}]} and w == []
    many = [{"dow": 1 + i % 7, "from": "01:00", "to": "02:00"} for i in range(15)]
    cfg, w = da.validate_schedule({"enabled": True, "weekly": many})
    assert len(cfg["weekly"]) == 14 and w == ["schedule_invalid"]
    for bad in ({"dow": 0, "from": "01:00", "to": "02:00"}, {"dow": 1, "from": "02:00", "to": "02:00"},
                {"dow": 1, "from": "24:00", "to": "24:00"}, {"dow": 1, "from": "01:00", "to": "24:30"},
                {"dow": 1, "from": "1:60", "to": "02:00"}, {"dow": True, "from": "01:00", "to": "02:00"}, "x"):
        cfg, w = da.validate_schedule({"enabled": True, "weekly": [bad]})
        assert cfg["weekly"] == [] and w == ["schedule_invalid"], bad
    assert da.validate_schedule({"enabled": True, "us_holidays": "yes"})[1] == ["schedule_invalid"]


def test_schedule_windows_thai_time():
    cfg = {"us_holidays": False, "weekly": [{"dow": 5, "from": 21 * 60, "to": 24 * 60}]}
    t0 = utc(2026, 11, 9, 8)
    assert da.schedule_windows(cfg, t0) == [(utc(2026, 11, 13, 14), utc(2026, 11, 13, 17), "ตารางเวลา", "schedule")]
    inside = utc(2026, 11, 13, 15)                                   # Friday 22:00 Thai: the window is running
    assert [w[0] for w in da.schedule_windows(cfg, inside)] == [utc(2026, 11, 13, 14), utc(2026, 11, 20, 14)]
    after = utc(2026, 11, 13, 17, 30)
    assert [w[0] for w in da.schedule_windows(cfg, after)] == [utc(2026, 11, 20, 14)]


def test_nyse_holidays_table_and_new_york_dst():
    for d, name in da.NYSE_HOLIDAYS:
        day = date(*map(int, d.split("-")))
        assert day.weekday() < 5, (d, name)                          # every closure is a weekday
    assert len(da.NYSE_HOLIDAYS) == 20
    assert da.ny_utc_offset_min(date(2026, 3, 8)) == -300 and da.ny_utc_offset_min(date(2026, 3, 9)) == -240
    assert da.ny_utc_offset_min(date(2026, 11, 1)) == -240 and da.ny_utc_offset_min(date(2026, 11, 2)) == -300
    assert da.ny_utc_offset_min(date(2027, 3, 14)) == -300 and da.ny_utc_offset_min(date(2027, 3, 15)) == -240

    def win(day):
        return [(f, t, n) for f, t, n, _ in da.holiday_windows(utc(*day) - 86400)]
    assert win((2026, 7, 3)) == [(utc(2026, 7, 3, 4), utc(2026, 7, 4, 4), "Independence Day (observed)")]
    assert win((2027, 3, 26)) == [(utc(2027, 3, 26, 4), utc(2027, 3, 27, 4), "Good Friday")]
    assert win((2027, 12, 24)) == [(utc(2027, 12, 24, 5), utc(2027, 12, 25, 5), "Christmas Day (observed)")]
    assert da.holiday_windows(utc(2026, 11, 9)) == []


def test_merge_windows_joins_overlaps_and_touching_windows():
    m = da.merge_windows([(0, 600, "a", "news"), (600, 1200, "b", "news"), (300, 900, "a", "schedule"),
                          (3000, 3600, "c", "holiday")])
    assert m == [{"from_utc": da.iso_z(0), "to_utc": da.iso_z(1200), "reason": "a, b", "kinds": ["news", "schedule"]},
                 {"from_utc": da.iso_z(3000), "to_utc": da.iso_z(3600), "reason": "c", "kinds": ["holiday"]}]


def test_normalize_ff_events():
    ev = da.normalize_ff_events(FF_WEEK)
    assert len(ev) == 6 and ev[0]["title"] == "Non-Farm Employment Change"
    assert ev[0]["ts_utc"] == "2026-11-06T13:30:00Z" and ev[0]["forecast"] == "65K"
    zew = [e for e in ev if e["currency"] == "EUR"][0]
    assert zew["forecast"] is None and zew["impact"] == "Medium"
    with pytest.raises(ValueError):
        da.normalize_ff_events({"not": "a list"})
    with pytest.raises(ValueError):
        da.normalize_ff_events([{"title": "x"}])
    assert da.normalize_ff_events([]) == []


def test_news_feed_due_rules(tmp_path):
    news = FakeNewsTransport(FF_WEEK)
    feed = da.NewsFeed(str(tmp_path / "cache.json"), news)
    t0 = utc(2026, 11, 9, 8)
    assert feed.due(t0) and feed.refresh(t0) and not feed.due(t0 + 4 * 3600 - 1) and feed.due(t0 + 4 * 3600)
    sat = utc(2026, 11, 14, 12)                                      # the cached week is over (last event Thu)
    feed2 = da.NewsFeed(str(tmp_path / "cache.json"), news)
    feed2.cache["fetched_at"] = sat - 2 * 3600
    assert feed2.due(sat)
    feed2.cache["fetched_at"] = sat - 3600
    assert not feed2.due(sat)
    feed2.cache["fetched_at"] = sat + 3600                           # the PC clock went back an hour
    assert feed2.due(sat)


def test_strip_auto_values_is_format_independent():
    auto = ["2026.11.10 15:00-16:30"]
    assert da.strip_auto_values(["2026.11.10 15:00-2026.11.10 16:30", "2026.11.11 10:00-11:00"], auto) == \
        ["2026.11.11 10:00-11:00"]
    assert da.strip_auto_values(["2026.11.10 15:00-16:30"], auto, keep_values=["2026.11.10 15:00-16:30"]) == \
        ["2026.11.10 15:00-16:30"]


def test_register_never_seeds_the_pc_s_own_auto_lines(tmp_path):
    parsed = da.parse_control_text("mode=run\r\nblackout=2026.11.10 15:00-16:30\r\nblackout=2026.11.11 15:00-16:00\r\n"
                                   "id=W004\r\n")
    d = da.desired_from_files({}, parsed, 120, utc(2026, 11, 9, 8), exclude_blackouts=["2026.11.10 15:00-16:30"])
    assert d["blackouts"] == [{"from_utc": "2026-11-11T13:00:00Z", "to_utc": "2026-11-11T14:00:00Z",
                               "label": "local"}]

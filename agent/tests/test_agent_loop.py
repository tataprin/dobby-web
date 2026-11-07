# -*- coding: utf-8 -*-
"""The agent loop against the fake Supabase (SPEC 3.4)."""
import json
import os

import pytest

import dobby_agent as da
from conftest import BOT, KEY, Env, utc


def lines(b):
    return b.decode("utf-8").split("\r\n")


def desired(live=True, mode="run", lots=0.03, blackouts=None, params=None, note=""):
    return {"live": live, "control": {"mode": mode, "lots": lots, "allow_long": True, "allow_short": True,
                                      "max_spread": None, "note": note},
            "blackouts": blackouts or [], "params": params}


@pytest.fixture
def live_env(tmp_path):
    """Registered bot, web says live=on v5, agent already applied v4 with live=on (normal running state)."""
    e = Env(tmp_path, desired=desired(), version=5, config_extra={"server_utc_offset_min": 120})
    st = da.default_state()
    st.update({"applied_version": 4, "applied_live": True, "reported_version": 4})
    da.write_json_atomic(os.path.join(e.agent_dir, da.STATE_NAME), st)
    return e


# ------------------------------------------------------------------------------------------------------- first cycle
def test_first_cycle_uploads_and_writes_control(env):
    a = env.agent()
    assert a.cycle() == 5
    f = env.fake
    assert len(f.status_rows) == 1 and f.status_rows[0][0]["bot_id"] == BOT
    assert f.status_rows[0][0]["status"]["symbol"] == "XAUUSD"
    assert len(f.journal) == 20 and f.journal_posts == [20]
    text = env.read(da.CONTROL_NAME)
    assert lines(text)[1:-1] == ["mode=pause", "lots=0.03", "allow_long=1", "allow_short=1", "id=W001", "note=web"]
    assert text.endswith(b"\r\n") and not os.path.exists(env.path(da.REMOTE_NAME))
    bots = f.bots_patches[-1]
    assert bots["agent_version"] == da.AGENT_VERSION and bots["ea_version"] == "3.03" and bots["symbol"] == "XAUUSD"
    ast = bots["agent_state"]
    for k in ("agent_version", "applied_version", "applied_at", "limits", "rejected", "last_error",
              "ea_heartbeat_age_s", "control_file_id", "remote_file_version"):
        assert k in ast, k
    assert ast["applied_version"] == 1 and ast["control_file_id"] == "W001" and ast["rejected"] == []
    assert ast["limits"]["max_lots"] == 0.10 and ast["ea_heartbeat_age_s"] == 0
    assert "balance" not in json.dumps(ast)                      # no money in bots (the admin can read it)
    # every REST call: apikey + the user's access token; the key itself is never a Bearer token
    for c in f.rest_calls():
        assert c["headers"]["apikey"] == KEY and c["headers"]["Authorization"].startswith("Bearer access-token-")
        assert KEY not in c["headers"]["Authorization"]
    st = env.state()
    assert st["applied_version"] == 1 and st["journal"]["offset"] == os.path.getsize(env.path(da.JOURNAL_NAME))
    with open(os.path.join(env.agent_dir, da.DECISIONS_NAME), encoding="utf-8") as fh:
        assert "v1 applied | live=off mode=pause" in fh.read()


def test_no_rewrite_when_content_unchanged_then_rewrite_on_new_version(live_env):
    e = live_env
    a = e.agent()
    a.cycle()
    first = e.read(da.CONTROL_NAME)
    m1 = os.stat(e.path(da.CONTROL_NAME)).st_mtime
    assert lines(first)[1:3] == ["mode=run", "lots=0.03"] and b"id=W005" in first
    for _ in range(3):                                           # header time changes, content does not
        e.tick(7)
        a.cycle()
    assert e.read(da.CONTROL_NAME) == first and os.stat(e.path(da.CONTROL_NAME)).st_mtime == m1
    e.fake.web_set(desired(mode="pause", note="FOMC"))
    e.tick(5)
    a.cycle()
    second = e.read(da.CONTROL_NAME)
    assert b"mode=pause\r\n" in second and b"id=W006\r\n" in second and b"note=web: FOMC\r\n" in second
    assert int(os.stat(e.path(da.CONTROL_NAME)).st_mtime) != int(m1)   # the EA sees a new modify second


def test_write_ea_file_always_changes_the_modify_second(tmp_path):
    p = str(tmp_path / "x.txt")
    da.write_ea_file(p, "a\r\n")
    m1 = os.stat(p).st_mtime
    da.write_ea_file(p, "b\r\n")
    assert int(os.stat(p).st_mtime) > int(m1)
    assert not os.path.exists(p + ".tmp")


def test_journal_batches_of_500_and_no_reupload(tmp_path):
    e = Env(tmp_path, copy_journal=False)
    with open(e.path(da.JOURNAL_NAME), "wb") as f:
        f.write((da.JOURNAL_HEADER + "\r\n").encode())
        for i in range(1200):
            f.write(("2026.11.0%d %02d:%02d:%02d,SKIP,C5G,SELL,0.00,,,,0.00,280.00,0,\"n %d, x\"\r\n" % (
                2 + i // 1000, (i // 60) % 24, i % 60, i % 60, i)).encode())
    a = e.agent()
    a.cycle()
    assert e.fake.journal_posts == [500, 500, 200] and len(e.fake.journal) == 1200
    e.tick(5)
    a.cycle()
    assert e.fake.journal_posts == [500, 500, 200]
    with open(e.path(da.JOURNAL_NAME), "ab") as f:
        f.write(b"2026.11.09 10:00:00,STOP,ALL,NONE,0.00,,,,0.00,280.00,0,deinit reason 1\r\n")
    e.tick(5)
    a.cycle()
    assert e.fake.journal_posts[-1] == 1
    # a restarted agent (state on disk) does not upload old rows again
    b = e.agent()
    e.tick(5)
    b.cycle()
    assert e.fake.journal_posts == [500, 500, 200, 1]


def test_status_upload_throttled_and_bots_every_30s(env):
    a = env.agent()
    a.cycle()
    env.tick(5)
    a.cycle()                                                    # heartbeat changed but < 10 s
    assert len(env.fake.status_rows) == 1 and len(env.fake.bots_patches) == 1
    env.tick(5)
    a.cycle()
    assert len(env.fake.status_rows) == 2 and len(env.fake.bots_patches) == 1
    env.clock.advance(10)                                        # heartbeat unchanged: no upload
    a.cycle()
    assert len(env.fake.status_rows) == 2
    env.tick(11)
    a.cycle()
    assert len(env.fake.bots_patches) == 2


# ------------------------------------------------------------------------------------------------------- adoption
LOCAL_FILE = ("# Dobby2 control file, written 2026-11-09 15:01:00 by dobby2_control.py\r\n"
              "mode=run\r\nlots=0.02\r\nallow_long=1\r\nallow_short=0\r\n"
              "blackout=2026.11.10 15:00-16:30\r\nid=C007\r\nnote=FOMC, AI\r\n")


def write_local(e, text, later=5):
    p = e.path(da.CONTROL_NAME)
    with open(p, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    t = os.stat(p).st_mtime + later
    os.utime(p, (t, t))


def test_local_change_is_adopted_and_never_turns_live_on(tmp_path):
    e = Env(tmp_path, desired=desired(live=False), version=5, config_extra={"server_utc_offset_min": 120})
    a = e.agent()
    a.cycle()
    assert b"mode=pause" in e.read(da.CONTROL_NAME) and b"id=W005" in e.read(da.CONTROL_NAME)
    write_local(e, LOCAL_FILE)                                   # monitor/dobby2_control.py resumes + lowers lots
    e.tick(5)
    a.cycle()
    assert len(e.fake.control_patches) == 1
    patch = e.fake.control_patches[0]
    assert patch["params"] == {"bot_id": "eq." + BOT, "version": "eq.5"}
    new = patch["body"]["desired"]
    assert new["live"] is False                                  # untouched: a local change never turns live on
    assert new["control"]["mode"] == "run" and new["control"]["lots"] == 0.02
    assert new["control"]["allow_short"] is False and new["control"]["note"] == "local change: FOMC, AI"
    assert new["blackouts"] == [{"from_utc": "2026-11-10T13:00:00Z", "to_utc": "2026-11-10T14:30:00Z",
                                 "label": "local"}]
    assert new["params"] is None
    assert e.fake.control["version"] == 6 and e.fake.control["desired"]["live"] is False
    text = e.read(da.CONTROL_NAME)                               # re-applied as v6; live=off still pauses
    assert lines(text)[1:-1] == ["mode=pause", "lots=0.02", "allow_long=1", "allow_short=0",
                                 "blackout=2026.11.10 15:00-16:30", "id=W006", "note=web: local change: FOMC, AI"]
    e.tick(5)
    a.cycle()
    assert len(e.fake.control_patches) == 1                      # adopted once


def test_local_pause_while_live_is_adopted_as_pause(live_env):
    e = live_env
    a = e.agent()
    a.cycle()
    write_local(e, LOCAL_FILE.replace("mode=run", "mode=pause"))
    e.tick(5)
    a.cycle()
    new = e.fake.control_patches[0]["body"]["desired"]
    assert new["live"] is True and new["control"]["mode"] == "pause"


def test_own_w_file_and_identical_local_file_are_not_adopted(live_env):
    e = live_env
    a = e.agent()
    a.cycle()
    ours = e.read(da.CONTROL_NAME).decode().replace("lots=0.03", "lots=0.01")
    write_local(e, ours)                                         # hand edit keeping our W id: re-applied, not adopted
    e.tick(5)
    a.cycle()
    assert e.fake.control_patches == [] and b"lots=0.03" in e.read(da.CONTROL_NAME)
    same = "mode=run\r\nlots=0.03\r\nallow_long=1\r\nallow_short=1\r\nid=C009\r\nnote=x\r\n"
    write_local(e, same, later=10)
    e.tick(5)
    a.cycle()
    assert e.fake.control_patches == []                          # nothing to tell the web


def test_adoption_loses_to_a_concurrent_web_change(live_env):
    e = live_env
    a = e.agent()
    a.cycle()
    write_local(e, LOCAL_FILE)
    e.fake.web_set(desired(lots=0.01, note="web wins"))          # v6 written on the website meanwhile
    real_fetch = a._fetch_control
    calls = {"n": 0}

    def fetch():                                                 # the agent's first read still saw v5
        calls["n"] += 1
        r = real_fetch()
        return dict(r, version=5) if calls["n"] == 1 else r
    a._fetch_control = fetch
    e.tick(5)
    a.cycle()
    assert e.fake.control["version"] == 6 and e.fake.control["desired"]["control"]["lots"] == 0.01
    assert b"lots=0.01" in e.read(da.CONTROL_NAME) and b"id=W006" in e.read(da.CONTROL_NAME)


# ------------------------------------------------------------------------------------------------------- tokens
def test_token_refresh_path_saves_rotated_token_and_keeps_local_limits(env):
    c = env.client()
    saved = []
    c.on_refresh_token = saved.append
    c.ensure_token()
    assert saved == ["rt-1"] and c.access_token == "access-token-1"
    env.clock.advance(3600 - 59)                                 # < 60 s left -> refresh before the next call
    c.select("bot_control", {"bot_id": "eq." + BOT, "select": "version,desired,updated_at"})
    assert saved == ["rt-1", "rt-2"]
    for call in env.fake.token_calls():
        assert call["params"]["grant_type"] == "refresh_token"
        assert call["headers"] == {"apikey": KEY, "Content-Type": "application/json", "Accept": "application/json"}
        assert "Authorization" not in call["headers"]
    env.fake.reject_access_once = True                           # 401 -> refresh once and retry
    assert c.select("bot_control", {"bot_id": "eq." + BOT, "select": "version,desired,updated_at"})[0]["version"]
    assert saved[-1] == "rt-3"


def test_agent_saves_rotated_token_without_undoing_a_limits_change(env):
    a = env.agent()
    da.update_config(env.cfg_path, lambda cfg: cfg["limits"].update({"allow_remote_control": False}))
    a.client.access_token = None
    a.client.refresh()                                           # rotation writes the config while limits changed
    cfg = env.config()
    assert cfg["refresh_token"] == "rt-1" and cfg["limits"]["allow_remote_control"] is False


def test_revoked_login_backs_off_and_leaves_files_alone(live_env):
    e = live_env
    a = e.agent()
    a.cycle()
    snap = e.snapshot()
    e.fake.valid_refresh.clear()
    a.client.access_token = None
    e.fake.web_set(desired(live=False))
    e.tick(5)
    assert a.cycle() == 60
    assert a.last_error.startswith("login:") and e.snapshot()["dobby2_control.txt"] == snap["dobby2_control.txt"]
    assert any("login" in t for t in e.tg_transport.texts())


def test_a_new_login_in_the_config_is_picked_up(env):
    a = env.agent()
    a.cycle()
    env.fake.valid_refresh.add("rt-from-login")
    da.update_config(env.cfg_path, lambda c: c.__setitem__("refresh_token", "rt-from-login"))
    a.client.access_token = None
    env.tick(5)
    a.cycle()
    assert env.fake.token_calls()[-1]["body"] == {"refresh_token": "rt-from-login"}


# ------------------------------------------------------------------------------------------------------- dry run / network
def test_dry_run_writes_nothing_and_uploads_nothing(tmp_path):
    e = Env(tmp_path, desired=desired(), version=3)
    write_local(e, LOCAL_FILE)
    before = e.snapshot()
    a = e.agent(dry_run=True)
    a.cycle()
    e.clock.advance(5)
    a.cycle()
    assert e.snapshot() == before
    methods = set((c["method"], c["url"].split("/rest/v1/")[-1]) for c in e.fake.rest_calls())
    assert methods == {("GET", "bot_control")}                   # reads only
    assert all(c["method"] == "POST" for c in e.fake.token_calls())
    assert not os.path.exists(os.path.join(e.agent_dir, da.STATE_NAME))
    assert not os.path.exists(os.path.join(e.agent_dir, da.DECISIONS_NAME))
    assert e.tg_transport.sent == []
    assert e.config()["refresh_token"] == "rt-1"                 # the rotated login is kept (or it would be lost)


def test_network_failure_never_touches_the_ea_files(live_env):
    e = live_env
    a = e.agent()
    a.cycle()
    e.fake.web_set(desired(live=False, lots=0.01))               # a change is waiting on the server ...
    e.fake.down = True                                           # ... but the network is down
    snap = e.snapshot()
    waits = []
    for _ in range(6):
        e.tick(5)
        waits.append(a.cycle())
        assert e.read(da.CONTROL_NAME) == snap[da.CONTROL_NAME][0]
        assert os.stat(e.path(da.CONTROL_NAME)).st_mtime == snap[da.CONTROL_NAME][1]
    assert waits == [10, 20, 40, 60, 60, 60]
    assert e.state()["applied_version"] == 5 and a.last_error.startswith("network:")
    e.fake.down = False
    e.tick(5)
    assert a.cycle() == 5
    assert b"mode=pause" in e.read(da.CONTROL_NAME) and b"id=W006" in e.read(da.CONTROL_NAME)
    assert e.fake.bots_patches[-1]["agent_state"]["last_error"] is None


def test_bot_control_post_is_never_used(live_env):
    a = live_env.agent()
    a.cycle()
    assert not [c for c in live_env.fake.rest_calls("POST") if "bot_control" in c["url"]]


# ------------------------------------------------------------------------------------------------------- local limits in the loop
def test_remote_control_disabled_writes_nothing(tmp_path):
    e = Env(tmp_path, desired=desired(), version=2, limits={"allow_remote_control": False})
    a = e.agent()
    a.cycle()
    e.tick(5)
    a.cycle()
    assert not os.path.exists(e.path(da.CONTROL_NAME)) and not os.path.exists(e.path(da.REMOTE_NAME))
    ast = e.fake.bots_patches[-1]["agent_state"]
    assert ast["rejected"] == ["remote_control_disabled"] and ast["applied_version"] == 0
    with open(os.path.join(e.agent_dir, da.DECISIONS_NAME), encoding="utf-8") as fh:
        assert fh.read().count("v2 NOT applied: remote_control_disabled") == 1
    da.update_config(e.cfg_path, lambda c: c["limits"].update({"allow_remote_control": True}))
    e.tick(5)
    a.cycle()                                                    # switched back on: applied at once
    assert b"id=W002" in e.read(da.CONTROL_NAME)


def test_live_not_allowed_locally_keeps_paused_and_reports(tmp_path):
    e = Env(tmp_path, desired=desired(live=False), version=1)
    a = e.agent()
    a.cycle()
    e.fake.web_set(desired(live=True))
    e.tick(5)
    a.cycle()
    assert b"mode=pause" in e.read(da.CONTROL_NAME)
    assert e.fake.bots_patches[-1]["agent_state"]["rejected"] == ["live_not_allowed_locally"]
    assert any("ไม่อนุญาต" in t for t in e.tg_transport.texts())


def test_live_switch_applied_and_alerted(tmp_path):
    e = Env(tmp_path, desired=desired(live=False), version=1, limits={"allow_remote_live": True})
    a = e.agent()
    a.cycle()
    e.fake.web_set(desired(live=True))
    e.tick(5)
    a.cycle()
    assert b"mode=run" in e.read(da.CONTROL_NAME)
    assert "[Main PC] เปิดการเทรดจริงแล้ว (คำสั่งจากเว็บ v2)" in e.tg_transport.texts()
    assert e.read(da.REMOTE_NAME).decode().split("\r\n")[1:-1] == ["version=2", "live=1"]
    e.fake.web_set(desired(live=False))
    e.tick(5)
    a.cycle()
    assert b"mode=pause" in e.read(da.CONTROL_NAME)
    assert e.read(da.REMOTE_NAME).decode().split("\r\n")[1:-1] == ["version=3", "live=0"]
    assert e.fake.bots_patches[-1]["agent_state"]["remote_file_version"] == 3


def test_clamped_lots_in_the_file(tmp_path):
    e = Env(tmp_path, desired=desired(lots=0.5), version=1, limits={"max_lots": 0.05})
    a = e.agent()
    a.cycle()
    assert b"lots=0.05\r\n" in e.read(da.CONTROL_NAME)
    assert e.fake.bots_patches[-1]["agent_state"]["rejected"] == ["lots_clamped"]


def test_remote_params_rejected_block_keeps_last_applied_params(tmp_path):
    e = Env(tmp_path, desired=desired(params={"InpLotsA": 0.05, "InpMaxAttempts": 3}), version=1,
            limits={"allow_remote_params": True})
    a = e.agent()
    a.cycle()
    good = e.read(da.REMOTE_NAME)
    assert good.decode().split("\r\n")[1:-1] == ["version=1", "InpLotsA=0.05", "InpMaxAttempts=3"]
    e.fake.web_set(desired(params={"InpLotsA": 0.50, "InpMaxAttempts": 3}))
    e.tick(5)
    a.cycle()
    assert e.read(da.REMOTE_NAME) == good                        # nothing new for the EA
    assert e.fake.bots_patches[-1]["agent_state"]["rejected"] == ["params_lots_over_limit"]
    e.fake.web_set(desired(params={"InpLotsA": 0.04}))
    e.tick(5)
    a.cycle()
    assert e.read(da.REMOTE_NAME).decode().split("\r\n")[1:-1] == ["version=3", "InpLotsA=0.04"]
    e.fake.web_set(desired(params={"InpLotsA": 0.04}, note="only a note"))
    e.tick(5)
    a.cycle()                                                    # same live/params: remote file not rewritten
    assert b"version=3" in e.read(da.REMOTE_NAME)


def test_remote_file_neutralised_when_both_remote_switches_go_off(tmp_path):
    e = Env(tmp_path, desired=desired(), version=1, limits={"allow_remote_live": True})
    a = e.agent()
    a.cycle()
    assert b"live=1" in e.read(da.REMOTE_NAME)
    da.update_config(e.cfg_path, lambda c: c["limits"].update({"allow_remote_live": False}))
    e.tick(5)
    a.cycle()
    assert e.read(da.REMOTE_NAME).decode().split("\r\n")[1:-1] == ["version=1"]
    e2 = Env(tmp_path / "b", desired=desired(), version=1)
    e2.agent().cycle()
    assert not os.path.exists(e2.path(da.REMOTE_NAME))           # never created when both are off


# ------------------------------------------------------------------------------------------------------- alerts
def test_journal_alerts_only_for_new_rows(env):
    a = env.agent()
    a.cycle()
    assert env.tg_transport.texts() == []                        # history backfill: no Telegram flood
    with open(env.path(da.JOURNAL_NAME), "ab") as f:
        f.write(b"2026.11.09 10:00:05,OPEN,C5G,BUY,0.03,2600.10,2594.10,2609.10,0.00,283.26,0,c5g long\r\n")
        f.write(b"2026.11.09 10:30:00,CLOSE,C5G,BUY,0.03,2609.10,,,27.00,310.26,0,reason=TP pos=1000004\r\n")
        f.write(b"2026.11.09 10:31:00,SKIP,C5G,BUY,0.00,,,,0.00,310.26,0,ignored\r\n")
    env.tick(5)
    a.cycle()
    t = env.tg_transport.texts()
    assert len(t) == 2 and t[0].startswith("[Main PC] เปิดออเดอร์ C5G BUY") and "กำไร +27.00" in t[1]
    env.tick(5)
    a.cycle()
    assert len(env.tg_transport.texts()) == 2
    assert env.state()["day_stats"]["2026.11.09"] == {"n": 1, "wins": 1, "losses": 0, "pnl": 27.0}


def test_offline_online_and_cap_alerts(env):
    a = env.agent()
    a.cycle()
    env.clock.advance(121)                                       # heartbeat stops
    a.cycle()
    a.cycle()
    t = env.tg_transport.texts()
    assert len(t) == 1 and t[0].startswith("[Main PC] EA ออฟไลน์: ไม่ได้รับสัญญาณจาก EA มา 2 นาที")
    env.tick(1)
    a.cycle()
    assert env.tg_transport.texts()[-1] == "[Main PC] EA กลับมาออนไลน์แล้ว"
    env.tick(5, virtual=dict(env.status["virtual"], day_cap_hit=True, day_pnl=-31.0))
    a.cycle()
    assert env.tg_transport.texts()[-1].startswith("[Main PC] ถึงเพดานขาดทุนรายวันแล้ว: P&L วันนี้ -31.00")
    env.tick(5)
    a.cycle()
    assert len(env.tg_transport.texts()) == 3


def test_offline_alert_state_survives_a_restart(env):
    a = env.agent()
    env.clock.advance(500)
    a.cycle()
    assert len(env.tg_transport.texts()) == 1
    env.agent().cycle()
    assert len(env.tg_transport.texts()) == 1


def test_daily_summary_once_at_server_2330(tmp_path):
    e = Env(tmp_path, config_extra={"server_utc_offset_min": 120})
    e.clock.t = utc(2026, 11, 9, 21, 29, 0)                      # server 23:29
    e.write_status(virtual=dict(e.status["virtual"], day="2026.11.09", day_pnl=15.5, balance=320.0))
    a = e.agent()
    a.cycle()
    assert not [t for t in e.tg_transport.texts() if "สรุป" in t]
    e.tick(61)
    a.cycle()
    e.tick(5)
    a.cycle()
    s = [t for t in e.tg_transport.texts() if "สรุป" in t]
    assert s == ["[Main PC] สรุปวันที่ 2026.11.09 (เวลาเซิร์ฟเวอร์)\nP&L วันนี้ +15.50 | virtual 320.00\n"
                 "ปิดออเดอร์ 0 ครั้ง (ชนะ 0 / แพ้ 0) รวม +0.00"]


def test_internal_error_does_not_kill_the_loop(env, monkeypatch):
    a = env.agent()
    monkeypatch.setattr(a, "_apply_control", lambda row, now: 1 / 0)
    assert a.cycle() == 10 and a.last_error.startswith("internal error")
    monkeypatch.undo()


def test_log_file_never_contains_secrets(tmp_path):
    e = Env(tmp_path)
    long_rt = "refresh-long-SECRET-0"
    e.fake.valid_refresh.add(long_rt)
    da.update_config(e.cfg_path, lambda c: c.__setitem__("refresh_token", long_rt))
    da.setup_logging(e.agent_dir)
    try:
        a = e.agent()
        a.cycle()
        da.LOG.warning("oops refresh=%s key=%s tg=%s", long_rt, KEY, "123456:TELEGRAM-SECRET-TOKEN")
        e.tg_transport.fail = "network"
        a.telegram.notify("error", "x")
        a.telegram.flush()
    finally:
        for h in list(da._OUR_HANDLERS):
            da.LOG.removeHandler(h)
            h.close()
        del da._OUR_HANDLERS[:]
        da.LOG.propagate = True
    with open(os.path.join(e.agent_dir, da.LOG_NAME), encoding="utf-8") as f:
        log = f.read()
    assert "oops refresh=*** key=*** tg=***" in log
    for secret in ("refresh-long-SECRET-0", KEY, "TELEGRAM-SECRET-TOKEN", "access-token-1"):
        assert secret not in log

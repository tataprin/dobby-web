# -*- coding: utf-8 -*-
"""SPEC 10.6 shadow AI: while the EA reports an open Dobby position the agent posts a snapshot to the Edge Function
`shadow` every next_after_s seconds, logs the answer to shadow_decisions.jsonl, pauses on shadow_disabled / budget,
never uses a token that is about to expire, and never writes an EA file."""
import json
import os

import dobby_agent as da
from conftest import URL, KEY, BOT, OFFSET, server_time_str

POS = {"open": True, "module": "C5G", "ticket": 432543137, "side": "BUY", "lots": 0.2, "open_price": 4049.63,
       "sl": 4043.93, "tp": 4080.98, "profit": 28.0, "swap": 0.0, "open_time": "2026.11.09 09:45:00", "bars_held": 4,
       "comment": "D3 C5 d5.70 t8.55", "near_tp": False, "locked": False, "runner": {"on": True, "converted": False}}


class FakePost(object):
    def __init__(self, answers=None):
        self.calls = []
        self.answers = list(answers or [])

    def __call__(self, url, headers, body, timeout):
        self.calls.append({"url": url, "headers": headers, "body": body, "timeout": timeout})
        if self.answers:
            a = self.answers.pop(0)
            if isinstance(a, Exception):
                raise a
            return a
        return 200, {"ok": True, "id": len(self.calls), "decision": {"action": "hold", "new_sl": None, "confidence": 40,
                                                                      "reason": "ถือต่อ",
                                                                      "details": {"hold_target": 4058.18, "target_pnl": 171.0}},
                     "valid": True, "next_after_s": 300, "model": "claude-sonnet-5-5", "cost_usd": 0.008}


def open_status(env, **changes):
    positions = [{"open": False, "module": "A_new"}, {"open": False, "module": "NY"}, dict(POS),
                 {"open": False, "module": "ASIA16"}]
    env.write_status(positions=positions, position=dict(POS),
                     market={"bid": 4051.03, "ask": 4051.19, "spread": 0.16}, **changes)


def make(env, answers=None):
    a = env.agent()
    fake = FakePost(answers)
    a.shadow.post = fake
    a.shadow.threaded = False
    return a, fake


def log_lines(env):
    p = os.path.join(env.agent_dir, da.SHADOW_LOG_NAME)
    if not os.path.exists(p):
        return []
    with open(p, encoding="utf-8") as f:
        return [json.loads(x) for x in f if x.strip()]


def write_bars(env, n=40):
    t0 = env.clock() - n * 900
    lines = ["bar_time,decision_time,close,rsi,atr,sl_dist,h4_close,h4_ema,h4_ema_prev,trend,bull,bear,signal,note"]
    for i in range(n):
        st = server_time_str(t0 + i * 900)
        lines.append("%s,%s,%.2f,45.1,5.3,6.000,4050.65,4055.380,4055.573,-1,0,0,0,,4048.6,0,none" %
                     (st, st, 4040 + i * 0.5))
    with open(env.path(da.BARS_NAME), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def test_no_open_position_no_call(env):
    a, fake = make(env)
    a.cycle()
    env.tick(400)
    a.cycle()
    assert fake.calls == []
    assert log_lines(env) == []


def test_open_position_one_call_per_interval_and_log(env):
    write_bars(env)
    open_status(env)
    a, fake = make(env)
    before = env.snapshot()
    a.cycle()
    assert len(fake.calls) == 1
    c = fake.calls[0]
    assert c["url"] == URL + "/functions/v1/shadow"
    assert c["headers"]["apikey"] == KEY
    assert c["headers"]["Authorization"].startswith("Bearer ")
    snap = c["body"]["snapshot"]
    assert c["body"]["bot_id"] == BOT
    assert snap["position"]["ticket"] == 432543137 and "open" not in snap["position"]
    assert snap["market"]["bid"] == 4051.03
    assert len(snap["bars_m15"]) == da.SHADOW_BARS
    assert snap["bars_m15"][-1]["close"] == 4059.5 and snap["bars_m15"][-1]["vwap"] == 4048.6
    assert snap["server_utc_offset_min"] == OFFSET
    lines = log_lines(env)
    assert len(lines) == 1 and lines[0]["action"] == "hold" and lines[0]["ticket"] == 432543137
    assert lines[0]["details"] == {"hold_target": 4058.18, "target_pnl": 171.0}
    assert lines[0]["comment"] == "D3 C5 d5.70 t8.55"
    for _ in range(10):          # 50 s later: still inside the 300 s interval
        env.tick(5, positions=env.status["positions"])
        a.cycle()
    assert len(fake.calls) == 1
    env.tick(260, positions=env.status["positions"])
    a.cycle()
    assert len(fake.calls) == 2
    # the shadow watcher writes nothing into the EA folder (the control file is the normal agent's work)
    after = env.snapshot()
    assert set(after) - set(before) <= {"dobby2_control.txt", "dobby3_remote.txt"}
    assert not [n for n in after if "shadow" in n]
    assert os.path.exists(os.path.join(env.agent_dir, da.SHADOW_LOG_NAME))


def test_pause_on_shadow_disabled(env):
    open_status(env)
    a, fake = make(env, answers=[(403, {"error": "shadow_disabled", "message": "off"})])
    a.cycle()
    assert len(fake.calls) == 1
    env.tick(600, positions=env.status["positions"])
    a.cycle()
    assert len(fake.calls) == 1                    # paused 30 min
    assert a.agent_state(env.clock())["shadow"]["paused"] == "shadow_disabled"
    env.tick(1300, positions=env.status["positions"])
    a.cycle()
    assert len(fake.calls) == 2
    assert log_lines(env)[0]["error"] == "shadow_disabled"


def test_network_error_retries_after_two_minutes(env):
    open_status(env)
    a, fake = make(env, answers=[da.NetworkError("down")])
    a.cycle()
    assert log_lines(env)[0]["error"] == "network"
    env.tick(60, positions=env.status["positions"])
    a.cycle()
    assert len(fake.calls) == 1
    env.tick(65, positions=env.status["positions"])
    a.cycle()
    assert len(fake.calls) == 2


def test_token_about_to_expire_is_not_used(env):
    open_status(env)
    a, fake = make(env)
    a.client.ensure_token()
    a.client.expires_at = env.clock() + 100       # less than SHADOW_TOKEN_LEFT_S left
    a.shadow.step(env.status, env.clock())
    assert fake.calls == []


def test_switched_off_in_config_or_dry_run(env):
    open_status(env)
    cfg = env.config()
    cfg["shadow"] = False
    da.save_config(env.cfg_path, cfg)
    a, fake = make(env)
    a.cycle()
    assert fake.calls == []
    cfg["shadow"] = True
    da.save_config(env.cfg_path, cfg)
    d = env.agent(dry_run=True)
    fake2 = FakePost()
    d.shadow.post, d.shadow.threaded = fake2, False
    d.cycle()
    assert fake2.calls == []


def test_closed_trade_is_forgotten(env):
    open_status(env)
    a, fake = make(env)
    a.cycle()
    assert 432543137 in a.shadow.next_at
    env.tick(5, positions=[{"open": False, "module": m} for m in ("A_new", "NY", "C5G", "ASIA16")])
    a.cycle()
    assert a.shadow.next_at == {}


def test_shadow_bar_rows_needs_the_offset():
    assert da.shadow_bar_rows("h\n2026.11.11 13:45:00,x,4044.39,39.2,5.4,6,4050,4055,4055,-1", None) == []
    rows = da.shadow_bar_rows("h\n2026.11.11 13:45:00,x,4044.39,39.2,5.4,6,4050,4055,4055,-1", 120)
    assert rows == [{"t_utc": "2026-11-11T11:45:00Z", "close": 4044.39, "rsi": 39.2, "atr": 5.4, "h4_close": 4050.0,
                     "h4_ema": 4055.0, "trend": -1.0, "vwap": None}]

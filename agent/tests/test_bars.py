"""SPEC 8: the EA's M15 bars go to bots.agent_state.bars for the website's price chart."""
import json

import dobby_agent as da
from conftest import Env, server_time_str  # noqa: F401

HEADER = "bar_time,decision_time,close,rsi,atr,sl_dist,h4_close,h4_ema,h4_ema_prev,trend,bull,bear,signal,note\n"


def bar_line(server_dt, close, vwap=None):
    base = "%s,%s,%.2f,51.0,6.5,6.0,4060.0,4032.0,4030.0,1,0,0,0," % (server_dt, server_dt, close)
    return base + ("" if vwap is None else ",%.3f,0,none: outside order window" % vwap) + "\n"


def test_parse_bars_converts_server_time_and_reads_vwap():
    text = (HEADER + bar_line("2026.11.06 23:00:00", 4060.1) + bar_line("2026.11.06 23:15:00", 4063.8, 4061.106)
            + bar_line("2026.11.06 23:30:00", 4065.2, 4061.116))
    bars = da.parse_bars_text(text, 120)
    assert bars["tf"] == "M15"
    assert bars["t"][0] == da.naive_to_epoch(da.parse_server_dt("2026.11.06 21:00:00"))   # server UTC+2 -> UTC
    assert bars["c"] == [4060.1, 4063.8, 4065.2]
    assert bars["vwap"] == [None, 4061.106, 4061.116]


def test_parse_bars_keeps_last_n_sorted_unique_and_skips_bad_lines():
    lines = [HEADER, "garbage\n", "2026.11.06 10:00:00,x,notanumber\n"]
    for i in range(120):
        h, m = divmod(i * 15, 60)
        lines.append(bar_line("2026.11.05 %02d:%02d:00" % (h % 24, m) if h < 24 else "2026.11.06 %02d:%02d:00" % (h - 24, m),
                              4000 + i))
    lines.append(bar_line("2026.11.06 05:45:00", 9999.0))       # duplicate time: the later row wins
    bars = da.parse_bars_text("".join(lines), 0, keep=96)
    assert len(bars["t"]) == 96 and bars["t"] == sorted(bars["t"]) and len(set(bars["t"])) == 96
    assert bars["c"][-1] == 9999.0


def test_parse_bars_needs_offset_and_data():
    assert da.parse_bars_text(HEADER + bar_line("2026.11.06 23:00:00", 4060.1), None) is None
    assert da.parse_bars_text(HEADER, 120) is None
    assert da.parse_bars_text(None, 120) is None


def _write_bars(env, n=10):
    t0 = env.clock() - n * 900
    with open(env.path(da.BARS_NAME), "w", encoding="utf-8") as f:
        f.write(HEADER)
        for i in range(n):
            f.write(bar_line(server_time_str(t0 + i * 900), 4000 + i, 3999.5 + i))


def test_agent_state_has_bars_with_a_configured_offset(tmp_path):
    e = Env(tmp_path, config_extra={"server_utc_offset_min": 120})
    _write_bars(e)
    a = e.agent()
    a.cycle()
    ast = e.fake.bots_patches[-1]["agent_state"]
    assert ast["bars"]["c"] == [4000 + i for i in range(10)]
    assert abs(ast["bars"]["t"][-1] - (e.clock() - 900)) <= 1
    assert "balance" not in json.dumps(ast)


def test_agent_state_has_no_bars_while_the_offset_is_unconfirmed(tmp_path):
    e = Env(tmp_path)
    _write_bars(e)
    a = e.agent()
    a.cycle()
    assert "bars" not in e.fake.bots_patches[-1]["agent_state"]


def test_agent_state_without_a_bars_file(tmp_path):
    e = Env(tmp_path, config_extra={"server_utc_offset_min": 120})
    a = e.agent()
    a.cycle()
    assert "bars" not in e.fake.bots_patches[-1]["agent_state"]

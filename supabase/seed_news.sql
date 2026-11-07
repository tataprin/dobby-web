-- Dobby Web: news calendar seed (tier-1 US events, 2026-11-01 onward).
-- Source: research calendar r27 (events_2026.csv, times in US Eastern). Converted to UTC with the
-- America/New_York rules: EDT (UTC-4) from 2026-03-08 to 2026-11-01 02:00, EST (UTC-5) otherwise.
-- All rows below fall after the 2026-11-01 switch, so 08:30 ET = 13:30 UTC and 14:00 ET = 19:00 UTC.
-- PCE and GDP are tier 2/3 in the source, so they are not included. Safe to run again (on conflict do nothing).
insert into public.news_events (ts_utc, name, tier, note) values
  ('2026-11-06T13:30:00+00', 'US NFP (Non-Farm Payrolls)', 1, '2026-11-06 08:30 ET (US Eastern); NFP; source: bls.gov/schedule/2026/home.htm'),
  ('2026-11-10T13:30:00+00', 'US CPI', 1, '2026-11-10 08:30 ET (US Eastern); CPI; source: bls.gov/schedule/2026/home.htm'),
  ('2026-12-04T13:30:00+00', 'US NFP (Non-Farm Payrolls)', 1, '2026-12-04 08:30 ET (US Eastern); NFP; source: bls.gov/schedule/2026/home.htm'),
  ('2026-12-09T19:00:00+00', 'FOMC rate decision', 1, '2026-12-09 14:00 ET (US Eastern); FOMC_DECISION; source: federalreserve.gov/monetarypolicy/fomccalendars.htm (SEP)'),
  ('2026-12-09T19:30:00+00', 'FOMC press conference', 1, '2026-12-09 14:30 ET (US Eastern); FOMC_PRESSER; source: federalreserve.gov/monetarypolicy/fomccalendars.htm (presser assumed; every meeting since 2019)'),
  ('2026-12-10T13:30:00+00', 'US CPI', 1, '2026-12-10 08:30 ET (US Eastern); CPI; source: bls.gov/schedule/2026/home.htm')
on conflict (ts_utc, name) do nothing;

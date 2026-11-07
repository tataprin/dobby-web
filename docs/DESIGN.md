# Dobby Web — design direction "Hallmark" (2026-11-07)

**Subject:** a private dashboard for a gold-trading bot (XAUUSD, M15) used by its owner and a few Thai friends, mostly on
phones. **Primary job:** a glance tells you whether the bot is trading, how much money there is, and what it just did;
a second screen lets you change the bot's settings without knowing EA jargon.

**Idea:** a hallmark is the stamp struck into a gold bar to certify it. Dobby's dashboard certifies what the bot is
doing. The gold price is the protagonist of every screen; money is "engraved"; structure is quiet.
Calibrated against Robinhood (one big line chart as the hero, numbers first), Mercury (calm structure, few surfaces,
hairline grouping) and Apple Stocks (the price line itself is the interface) — borrowing their discipline, not their look.

## Tokens
| name | light | dark ("vault") | use |
|---|---|---|---|
| porcelain / vault | `#F1F2EE` | `#14191B` | page background (cool mineral, not cream) |
| sheet | `#FFFFFF` | `#1C2326` | the hero sheet and dialogs only |
| graphite | `#20262A` | `#E8EAE6` | text |
| slate | `#5E676D` | `#9AA3A8` | secondary text, hairlines at 18 % |
| fine gold | text `#8F6A17`, fill `#D4AE52` | text/fill `#D9B65C` | brand, primary action, selection, the hallmark |
| jade | `#1E7656` | `#45B98A` | profit, running, buy |
| cinnabar | `#B83A2A` | `#E2674F` | loss, danger, sell, offline |
Colour carries meaning only. No decorative gradients; the one exception is a faint metallic sheen on the hallmark.

**Type:** Thai and UI text in **Anuphan** (300–700); money, prices, lots and percentages in **Chakra Petch** 500/600
with `tabular-nums` (angular, stamped-metal numerals). Scale 13 / 15 / 17 / 21 / 28 / 40 / 56, Thai line-height 1.6,
lines under ~70 characters. Sentence case. No all-caps labels, no labels above every heading, no "A · B · C" meta
strings (use real sentences or separate chips), no arrows appended to buttons.

**Shape:** radius by hierarchy — hero sheet 22 px, panels 14 px, controls 10 px, rows 0 (hairline separated).
Shadow only on the hero sheet and dialogs (soft, low, warm-neutral), never on every block.

## Layout
```
desktop                                            phone
┌────────┬──────────────────────────────────────┐ ┌──────────────────────────┐
│ Dobby  │ XAUUSD 4,071.01 +12.30 วันนี้   บอท ▾ │ │ Dobby   4,071.01  บอท ▾  │
│        ├──────────────────────────────────────┤ ├──────────────────────────┤
│ ภาพรวม │ ┌──────────────────────────────────┐ │ │ [hallmark] กำลังเทรดจริง │
│ ตั้งค่า │ │ [hallmark]  กำลังเทรดจริง  +236.50 │ │ │ ~~~ price line ▲ ▼ ~~~~ │
│ ประวัติ │ │ ~~~~~ 24 h price line, ▲ ▼ ~~~~~ │ │ │ 1,231.98   +236.50       │
│ ข่าว   │ └──────────────────────────────────┘ │ │ ──────────────────────── │
│ เครื่อง │ 1,231.98 │ 1,233.10 │ +236.50 │ +32% │ │ ไม้ที่เปิด  SL─●──|──TP   │
│ วิธีใช้  │ ─────────────────────────────────── │ │ เทรดล่าสุด ...           │
│        │ ไม้ที่เปิดอยู่   SL ──●────|─── TP      │ ├──────────────────────────┤
│        │ เทรดล่าสุด (list, amounts right)     │ │ ภาพรวม ตั้งค่า ประวัติ เมนู │
└────────┴──────────────────────────────────────┘ └──────────────────────────┘
```
Left-aligned text, numbers right-aligned in lists. Settings: grouped rows (label left, control right), section anchors,
sticky save bar. Lists over card grids.

## Principles
1. **The market is always visible** — a live XAUUSD ticker in the header; the dashboard hero is today's price line with
   Dobby's own trades stamped on it (bars from `bots.agent_state.bars`, SPEC 8).
2. **Spend boldness once** — the hero (hallmark + price line). Everything else is quiet.
3. **Money is engraved** — Chakra Petch numerals, large, tabular; Thai prose in Anuphan.
4. **Meaning-only colour** — gold = Dobby/primary, jade = profit/running, cinnabar = loss/danger.
5. **One orchestrated motion** — on first load the line draws and the trade marks stamp in; otherwise motion only
   answers the user's action. `prefers-reduced-motion` turns it off.

## Refinements made while building it (2026-11-07)
- **Fine gold text is `#85621A`, not `#8F6A17`** (light theme): the original measures 4.40:1 on porcelain, below 4.5:1;
  `#85621A` gives 4.97:1 and still reads as gold. The fill `#D4AE52` is unchanged.
- **Coloured text never sits on a coloured tint** (jade on a jade tint drops to about 4.2:1). Chips and callouts use
  graphite text with a coloured icon or dot; jade / cinnabar text appears only on porcelain or sheet.
- **Caution has no fourth hue**: warnings use fine gold at low intensity; "paused" uses slate.
- **The hallmark has two finishes**: trading live = a solid struck gold plate (the faint sheen is the one gradient);
  slate (paused, not connected) and cinnabar (offline, needs attention) = an ink impression, outline only.
- **Chart axis text is 12 px** (inside charts only; everything else stays on the 13 / 15 / 17 / 21 / 28 / 40 / 56 scale).
- **Chakra Petch is loaded as a glyph subset** (digits, + − % $ : / ×, A–Z) so Thai inside a number span stays in Anuphan.
- **Thai loanwords are glued** (บอท, กำไร, สเปรด, พรีเซ็ต, ออนไลน์ …): the browser's Thai dictionary splits them
  mid-syllable ("บอ|ท"), so text built with `h()` joins them with word joiners and allows a break on either side.
- **On phones, dialogs rise from the bottom as sheets**; the settings page's section anchors become a sticky chip row.

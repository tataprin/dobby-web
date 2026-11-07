# Dobby Web — design direction "Hallmark" (2026-11-07, precision pass the same day)

**Subject:** a private dashboard for a gold-trading bot (XAUUSD, M15) used by its owner and a few Thai friends, mostly on
phones. **Primary job:** a glance tells you whether the bot is trading, how much money there is, and what it just did;
a second screen lets you change the bot's settings without knowing EA jargon.

**Idea:** a hallmark is the stamp struck into a gold bar to certify it. Dobby's dashboard certifies what the bot is
doing. The gold price is the protagonist of every screen; money is "engraved"; structure is quiet.
Calibrated against Robinhood (one big line chart as the hero, numbers first), Mercury (calm structure, few surfaces,
hairline grouping) and Apple Stocks (the price line itself is the interface) — borrowing their discipline, not their look.

## Reference notes (measured 2026-11-07 at a 1280 px viewport)
What makes the references feel expensive is not decoration but exactness: every box in a row is the same height, every
edge sits on a grid line, three or four type sizes do all the work, and colour is almost absent.

| reference | what was measured |
|---|---|
| Mercury (demo.mercury.com dashboard) | sidebar app, content column 968 px; cards in rows of 2 (472 + 24 + 472) and 3 (307 x 3), **gutter 24**, row gap 40; **equal heights per row** (350/350, 232 x 3, 464/464); card = white, **1 px border at ~10 % slate, radius 12, no shadow**, inner padding 24; body **15/24**, secondary **13/20**, page title **28/36** (weight 380), balance **28 px tabular with the cents at 73 %**; action buttons 32 px pills, 40 px controls; one accent colour. |
| Robinhood (stock page) | main column 863 + gutter 24 + rail 330; price **32/40** under a 32 px name; change line 13 px; panels 1 px border, radius 4, padding 20 / 24; key-value rows 30 px apart, label left / value right; CTA 44 px; one accent (the chart colour) + red / green for meaning only. |
| Stripe (stripe.com/th, Thai) | content ~1080 px; Thai body **16 px / 1.4**, headings light; buttons **48 and 40 px**, radius 4; sections separated by space, not boxes. |
| Linear (linear.app) | container max 1364 with 40 px side padding; type weights 510 / 590 (between regular and medium); display letter-spacing about -0.02 em; 32 px pill buttons; 13 px product UI (too dense for us). |
| Wise (wise.com/th) | body **16/24**, secondary **14/21.7**; list rows **72 px**; buttons 48 (primary) and 40; one hero card with a shadow, everything else flat. |

**Adopted:** content column max 1120 px; gutter 24 (16 on phones); one panel style (sheet, 1 px hairline, radius 12, no
shadow, padding 24 / 16); the only shadow is on the hero sheet and dialogs; body 16 px for Thai (1.6 line height),
secondary 14, page titles 28 on a 40 px line; figures 28 px tabular with the decimals at 72 % and the unit at 14 px slate;
buttons 40 / 48, inputs 44 (Thai text needs the extra height), rows 56–72 px; equal heights in every row by construction.

## Tokens
| name | light | dark ("vault") | use |
|---|---|---|---|
| porcelain / vault | `#F1F2EE` | `#14191B` | page background (cool mineral, not cream) |
| sheet | `#FFFFFF` | `#1C2326` | panels, the hero sheet, dialogs |
| graphite | `#20262A` | `#E8EAE6` | text |
| slate | `#5E676D` | `#9AA3A8` | secondary text, hairlines at 18 % |
| fine gold | text `#85621A`, fill `#D4AE52` | text/fill `#D9B65C` | brand, primary action, selection, the hallmark |
| jade | `#1E7656` | `#45B98A` | profit, running, buy |
| cinnabar | `#B83A2A` | `#E2674F` | loss, danger, sell, offline |
Colour carries meaning only. No decorative gradients; the one exception is a faint metallic sheen on the hallmark.

**Type:** Thai and UI text in **Anuphan** (300–700); money, prices, lots and percentages in **Chakra Petch** 500/600
with `tabular-nums` (angular, stamped-metal numerals). Sentence case. No all-caps labels, no labels above every heading,
no "A · B · C" meta strings (use real sentences or separate chips), no arrows appended to buttons.

## Layout system (strict; `css/app.css` "layout system")
- **One content column.** `.main`, the header (`.topbar-in`), the demo banner (`.demo-in`) and the save bar all use
  `max-width: 1120px` + the page padding (16 phone / 24 from 600 px / 32 with the sidebar), so every left and right edge
  on a page is the same line. Nothing is wider, nothing is inset by its own margin.
- **12-column grid, one gutter:** `--gutter` 24 px from 768 px, 16 px below; `.grid` + `.md-*` / `.lg-*` spans, `.grid-2`
  (two 6-column halves). Everything that sits side by side is on these lines: stat cells (4 x 3 columns from 1200 px,
  2 x 6 below), open trade + recent trades (6 + 6 from 768 px), settings and guide (9 + 3 from 1200 px), history filters
  (3 + 3 + 3 + 3), the preset editor (8 + 4). The vertical rhythm between page blocks is the same 24 px (16 on phones);
  top-level settings sections are 48 apart, sub-sections 32.
- **Spacing scale:** 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 (`--s1`..`--s8`). Nothing off-scale except 1–2 px hairlines.
- **One panel style:** `.panel` (and `.group`, `.fig`, `.machine`, `.g-sec`, `.news-day`, `.filters`) = sheet, 1 px
  `--hair` border, radius 12, padding 24 (16 on phones), panel head 40 px min (title 18 px + optional action), rows inside
  are hairline-separated, never boxes inside boxes. Only the hero (radius 16) and dialogs carry a shadow.
- **Equal sizes by construction:** rows of boxes are CSS grids with `align-items: stretch`; stat cells have identical
  structure (label, value, foot pinned to the bottom); the open-trade panel and the recent-trades list share one row
  height (the list is capped at 6 + "ดูทั้งหมด"; the open trade adds facts: price, time open, distance to TP / SL in $ and
  %, so both halves are full); grids of facts (machines, settings "now") are equal-width columns that line up from one
  machine / row to the next.
- **Component sizes (fixed):** buttons 40 px (`.btn`, `.btn.small` only changes the text to 14 px) and 48 px (`.btn.big`,
  the one CTA of a form); icon buttons 40 x 40; inputs and selects 44; segmented controls 44 (36 px segments); steppers
  44 x 192 (one width, so every settings row's control has the same edges); chips 28; switches 48 x 28 (one size for all
  on/off controls, gold for the live switch, jade for the rest); header controls (bot picker) 40. Icons 20 px with one
  stroke width (1.8); 16 px only inline in chips and 14 px text; the phone tab bar uses 22.
- **Type scale:** 13 (meta at the edge: tab-bar labels, calendar days, table labels on phones) / 14 secondary, labels,
  hints, chips / 16 body, buttons, inputs, list text / 18 panel titles, figures in lists / 22 section and dialog titles /
  28 page titles (40 px line = button height) and stat values / 40 the hero P&L. Nothing below 13 px except chart axis
  labels (12 px) and the text drawn inside the hallmark emblem and the guide illustrations (scaled pictures of the UI).
- **Numbers:** right-aligned in lists and tables, tabular, unit after the number in 14 px slate (`money()` in util.js:
  decimals at 72 %, never below 13 px). Signed with + / − (U+2212). Money 2 decimals, prices 2, lots 2, percentages 0–2.
- **Dates and times:** Thai time, Gregorian calendar. Lists and cells: `7 พ.ย. 18:30`, today as `วันนี้ 18:30`, dates
  `17 ต.ค. 2026`; "น." only inside sentences (toasts, hints); relative ages (`5 นาทีก่อน`) for "last seen".

## Layout
```
desktop (sidebar 240)                               phone
┌────────┬────────────────────────────────────────┐ ┌──────────────────────────┐
│ Dobby  │ XAUUSD 4,071.01 +12.30 วันนี้    บอท ▾ ? ☼│ │ Dobby 4,071.01  [บอท ▾]  │
│        ├────────────────────────────────────────┤ ├──────────────────────────┤
│ ภาพรวม │ ภาพรวม                         ? วิธีใช้ │ │ ภาพรวม                ?  │
│ ตั้งค่า │ ┌ hero: [hallmark] กำลังเทรดจริง  +59.61 ┐ │ │ ┌ hero ───────────────┐ │
│ ประวัติ │ │ ~~~~~ 24 h price line, ▲ ▼ ~~~~~       │ │ │ │ [stamp] กำลังเทรด    │ │
│ ข่าว   │ └ ค่าที่ใช้อยู่ ...      [หยุด] [งด 2 ชม.] ┘ │ │ │ ~~ line ~~  +59.61  │ │
│ เครื่อง │ [ยอดเงิน][มูลค่า][วันนี้ ▬][ตั้งแต่เริ่ม]   │ │ └─────────────────────┘ │
│ วิธีใช้  │ ┌ ไม้ที่เปิดอยู่ ──┐ ┌ เทรดล่าสุด ───────┐ │ │ [ยอดเงิน][มูลค่า]       │
│        │ │ SL─●──|──TP     │ │ 6 rows, amounts → │ │ │ [วันนี้ ][ตั้งแต่เริ่ม] │
│        │ │ facts 2 x 2     │ │ ดูทั้งหมด          │ │ │ ไม้ที่เปิดอยู่ / เทรด... │
│        │ └─────────────────┘ └───────────────────┘ │ ├──────────────────────────┤
│        │ ┌ รายละเอียดเพิ่มเติม                   + ┐ │ │ ภาพรวม ตั้งค่า ประวัติ … │
└────────┴────────────────────────────────────────┘ └──────────────────────────┘
```
Left-aligned text, numbers right-aligned in lists. Settings (bot and account): grouped rows (label left, control right),
section anchors (sticky chips on narrow screens, a side list from 1200 px), sticky save bar. Lists over card grids.

## Principles
1. **The market is always visible** — a live XAUUSD ticker in the header (22 px price on desktop); the dashboard hero is
   today's price line with Dobby's own trades stamped on it (bars from `bots.agent_state.bars`, SPEC 8).
2. **Spend boldness once** — the hero (hallmark + price line + 40 px P&L). Everything else is quiet.
3. **Money is engraved** — Chakra Petch numerals, large, tabular, decimals smaller; Thai prose in Anuphan.
4. **Meaning-only colour** — gold = Dobby/primary, jade = profit/running, cinnabar = loss/danger.
5. **One orchestrated motion** — on first load the line draws and the trade marks stamp in; otherwise motion only
   answers the user's action. `prefers-reduced-motion` turns it off.
6. **Exactness over ornament** — equal heights, shared edges, fixed control sizes; checked by `dev/layout-audit.js`.

## Refinements made while building it (2026-11-07)
- **Fine gold text is `#85621A`, not `#8F6A17`** (light theme): the original measures 4.40:1 on porcelain, below 4.5:1;
  `#85621A` gives 4.97:1 and still reads as gold. The fill `#D4AE52` is unchanged.
- **Coloured text never sits on a coloured tint** (jade on a jade tint drops to about 4.2:1). Chips and callouts use
  graphite text with a coloured icon or dot; jade / cinnabar text appears only on porcelain or sheet.
- **Inactive rows are slate, not faded** (opacity dropped text below 4.5:1).
- **Caution has no fourth hue**: warnings use fine gold at low intensity; "paused" uses slate.
- **The hallmark has two finishes**: trading live = a solid struck gold plate (the faint sheen is the one gradient);
  slate (paused, not connected) and cinnabar (offline, needs attention) = an ink impression, outline only.
- **Chakra Petch is loaded as a glyph subset** (digits, + − % $ : / ×, A–Z) so Thai inside a number span stays in Anuphan.
- **Thai loanwords are glued** (บอท, กำไร, สเปรด, พรีเซ็ต, ออนไลน์ …): the browser's Thai dictionary splits them
  mid-syllable ("บอ|ท"), so text built with `h()` joins them with word joiners and allows a break on either side.
- **On phones, dialogs rise from the bottom as sheets**; the settings page's section anchors become a sticky chip row.
- **Chart.js colours are resolved per token** with a fresh probe element and a 1x1 canvas (it cannot parse `color-mix()`
  results, and a reused probe can return a stale colour).
- **The welcome tour shows once per browser** (demo included): "seen" is stored the moment it opens, in localStorage,
  sessionStorage and a cookie (any one is enough); วิธีใช้ → "ดูทัวร์แนะนำอีกครั้ง" replays it.

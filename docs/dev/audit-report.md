# Layout audit report

Generated 2026-11-07 17:06 UTC by `dev/layout-audit.js` (demo mode, served locally).
Every width ran all routes in light and dark: ภาพรวม, ตั้งค่าบอท, ประวัติ (5 tabs), ข่าว, เครื่องของฉัน, วิธีใช้, พรีเซ็ต,
คำนวณล็อต, ดาวน์โหลดแอป, ผู้ใช้ (บอทของสมาชิก and ผู้ใช้และรหัสเชิญ), บันทึก, ตั้งค่าบัญชี, a member's bot in the admin's
view-only mode (ภาพรวม, ประวัติ, ตั้งค่าบอท), a member's preset (read only), the no-bot state, the welcome tour, a confirm
dialog, a toast and the sign-in page (3 tabs); each page again with every `<details>` opened.

Run after the feature batch (SPEC 9, 2026-11-07) in headless Chrome over CDP (Runtime.evaluate in the page), demo mode, served locally. Routes added for the batch: ประวัติ > สรุป and เงินฝาก-ถอน, a trade page (a closed trade with lock steps), the same three on a member's bot in view-only mode, the cash-flow form and the ปรับทุนตั้งต้นของบอท dialog; ตั้งค่าบอท (automatic blackouts), ข่าว (merged calendar) and ตั้งค่าบัญชี are part of the default routes. No console errors.

| width | rowHeights | gaps | overlap | edges | fontSize | controls | icons | overflow | contrast | clipped | failures | illustration (info) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1440 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | 6 |
| 1280 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | 6 |
| 1024 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | 6 |
| 768 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | 6 |
| 390 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | 160 |
| 360 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | 180 |

## What each check means
- **rowHeights**: panels, cards, stat cells, facts side by side in one visual row whose heights differ by more than 2 px.
- **gaps**: neighbours in one row of a CSS grid that are not exactly one column-gap apart (content wider than its track).
- **overlap**: children of a grid / flex container that run into each other.
- **edges**: top-level boxes whose left / right edge is not on the content column or a 12-column grid line; the header and
  demo banner inner edges must equal the content column.
- **fontSize**: text below 13 px (SVG text measured at its rendered size).
- **controls**: `.btn` not 40 / 48, icon buttons not 40, inputs / selects not 44, segmented not 44, steppers not 44, chips not
  28, switches not 28, header controls not 40, any other button or input not in a known class.
- **icons**: an icon that is not 16 / 20 / 22 / 24 / 28 px.
- **overflow**: horizontal page overflow or an element past the right edge of the viewport.
- **contrast**: text below 4.5:1 (3:1 for large text) against its composited background, opacity included.
- **clipped**: text cut off (scrollWidth > clientWidth on an element that hides or spills its overflow).

## Justified exceptions (not counted as failures)
- **Chart axis labels** (`.pc-svg` text, Chart.js canvas): 12 px, the one place below 13 px allowed by DESIGN.md.
- **The hallmark emblem** (`.hm-svg`, `.brand-mark`): the struck words are part of the stamp drawing, sized with it.
- **Guide / tour illustrations** (`.g-art`, `.tour-art`, `.teach-art`; reported as "illustration"): scaled pictures of
  the UI (`role="img"` with a text alternative); the same information is in the numbered steps beside them. On a phone a
  360-unit drawing renders about 0.9x, so its mock labels fall to 8–12 px; drawing them at 13 px would make the pictures
  taller than the screen.
- **Parts of composite controls**: segments (36 px inside a 44 px segmented control), the − / + of a stepper, the phone tab
  bar links (64 px), the sign-in tabs (40 px text tabs), the save bar count, inline text buttons and calendar days.
- **Centred single-card pages** (sign-in, invite, 2FA, reset, setup): the 440 px card is centred on purpose, so the
  content-column edge check does not apply there.
- **Disabled controls** are skipped by the contrast check (WCAG exempts inactive components).
- **Scroll containers** (`.table-wrap`, the anchor chip row) may be wider than the viewport inside their own scroller.

## Fixed during the audit
- Inactive rows (unused strategies, revoked invites, past blackouts) were faded with opacity and fell to 2.5–4.2:1; they
  are slate text now.
- Segmented controls: inactive segments were 4.3:1 on the 13 % well; the track is the 7 % well now (4.7:1).
- Money decimals at 72 % went to 11.5 px in 16 px rows; `.money .dec` is `max(.72em, 13px)`.
- The bot-side picker on phones (three long segments) overflowed by 2 px at 390; phone segments use 14 px text and 8 px padding.
- History filters: the range control was wider than its 3-column track (24 px gap shrank to 8); segments use 8 px padding.
- Phone machine actions: quiet buttons on the well were 4.2:1 for the red "ลบออกจากเว็บ"; they are outlined on the sheet now.
- Chart.js colours: tokens resolved through one reused probe element came back stale (every colour gold in headless
  Chrome); each token now gets a fresh probe and a canvas round trip.

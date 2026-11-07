// The hallmark: the stamp struck into a gold bar. A rounded octagon with a double engraved outline, "Dobby" and the
// bot's state. Tones: gold = trading live (solid struck metal with a faint sheen, the one allowed gradient),
// slate = paused / not live, cinnabar = offline / error (both drawn as an ink impression, outline only).
import { h } from './util.js';

let seq = 0;

// Rounded octagon inside a square [x, x+s] with corner radius r (quadratic corners).
export function octagonPath(x, y, s, r) {
  const c = s * 0.2929; // regular octagon cut
  const pts = [[x + c, y], [x + s - c, y], [x + s, y + c], [x + s, y + s - c], [x + s - c, y + s], [x + c, y + s], [x, y + s - c], [x, y + c]];
  const n = pts.length;
  const lerp = (a, b, d) => { const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy); return [a[0] + (dx / len) * d, a[1] + (dy / len) * d]; };
  let d = '';
  for (let i = 0; i < n; i++) {
    const p = pts[i], prev = pts[(i + n - 1) % n], next = pts[(i + 1) % n];
    const a = lerp(p, prev, r), b = lerp(p, next, r);
    d += `${i ? 'L' : 'M'}${a[0].toFixed(2)} ${a[1].toFixed(2)}Q${p[0].toFixed(2)} ${p[1].toFixed(2)} ${b[0].toFixed(2)} ${b[1].toFixed(2)}`;
  }
  return d + 'Z';
}

// tone: 'gold' | 'slate' | 'cinnabar'
export function hallmarkSvg({ tone = 'gold', state = '', label = 'Dobby', title = '' } = {}) {
  const id = `hm${++seq}`;
  const solid = tone === 'gold';
  const outer = octagonPath(3, 3, 114, 13);
  const ring1 = octagonPath(9.5, 9.5, 101, 10);
  const ring2 = octagonPath(14, 14, 92, 8.5);
  const aria = title || [label, state].filter(Boolean).join(' ');
  const textY = state ? 58 : 68;
  return `<svg class="hm-svg" viewBox="0 0 120 120" role="img" aria-label="${aria}">
<defs><linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" style="stop-color:var(--gold-hi)"/><stop offset=".48" style="stop-color:var(--gold)"/><stop offset="1" style="stop-color:var(--gold-lo)"/></linearGradient></defs>
<path class="hm-plate" d="${outer}" ${solid ? `fill="url(#${id}g)"` : ''}/>
<path class="hm-ring" d="${ring1}" fill="none" stroke-width="${solid ? 1.6 : 2.2}"/>
<path class="hm-ring" d="${ring2}" fill="none" stroke-width="${solid ? 0.9 : 1.1}"/>
${solid ? `<text class="hm-shine" x="60" y="${textY + 0.9}" text-anchor="middle">${label}</text>` : ''}
<text class="hm-word" x="60" y="${textY}" text-anchor="middle">${label}</text>
${state ? `<path class="hm-rule" d="M44 68.5h32" stroke-width="1"/><text class="hm-state" x="60" y="86" text-anchor="middle">${state}</text>` : ''}
</svg>`;
}

export function hallmark({ tone = 'gold', state = '', size = 'lg', cls = '', title = '' } = {}) {
  return h('span', { class: `hallmark hm-${tone} hm-${size} ${cls}`.trim(), html: hallmarkSvg({ tone, state, title }) });
}

// The small brand mark (sidebar, header, login): the plate with a "D".
export function brandMark(cls = '') {
  const outer = octagonPath(2, 2, 28, 4.2);
  const ring = octagonPath(4.6, 4.6, 22.8, 3.2);
  return h('span', {
    class: `brand-mark ${cls}`.trim(), 'aria-hidden': 'true',
    html: `<svg viewBox="0 0 32 32"><path d="${outer}" fill="var(--gold)"/><path d="${ring}" fill="none" stroke="var(--hm-engrave)" stroke-width="1.1"/><text x="16" y="21.3" text-anchor="middle" class="bm-d">D</text></svg>`,
  });
}

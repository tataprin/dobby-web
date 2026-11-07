// MT5 .set files: UTF-16LE with BOM, CRLF, lines `Key=value||start||step||stop||N`, comments start with ';'.
// parseSet accepts UTF-16LE / UTF-16BE (with or without BOM) and UTF-8.
import { PARAMS, PARAM_BY_KEY, coerce, defaults } from './params.js';

export function decodeSetBytes(buf) {
  const b = new Uint8Array(buf);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  // No BOM: guess by NUL bytes (ASCII text in UTF-16 has a zero in every other byte).
  let zeroOdd = 0, zeroEven = 0;
  const n = Math.min(b.length, 400);
  for (let i = 0; i < n; i++) if (b[i] === 0) (i % 2 ? zeroOdd++ : zeroEven++);
  if (zeroOdd > n / 4) return new TextDecoder('utf-16le').decode(b);
  if (zeroEven > n / 4) return new TextDecoder('utf-16be').decode(b);
  return new TextDecoder('utf-8').decode(b);
}

// Returns {params (full, defaults for missing keys), found: [keys], missing: [keys], unknown: [{key, value}],
//          invalid: [{key, value}], comments: [lines]}
export function parseSetText(text) {
  const params = defaults();
  const found = [], unknown = [], invalid = [], comments = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(';')) { comments.push(line.replace(/^;\s?/, '')); continue; }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).split('||')[0].trim();
    const p = PARAM_BY_KEY[key];
    if (!p) { unknown.push({ key, value }); continue; }
    const v = coerce(p, value);
    if (v === undefined) { invalid.push({ key, value }); continue; }
    params[key] = v;
    found.push(key);
  }
  const missing = PARAMS.map((p) => p.key).filter((k) => !found.includes(k));
  return { params, found, missing, unknown, invalid, comments };
}

export function parseSet(buf) {
  return parseSetText(decodeSetBytes(buf));
}

function numText(p, v) {
  if (p.type !== 'double') return String(Math.round(v));
  const r = Math.round(v * 1e8) / 1e8;
  return Number.isInteger(r) ? r.toFixed(1) : String(r);
}

export function setLines(params, comments = []) {
  const lines = comments.map((c) => '; ' + String(c).replace(/[\r\n]+/g, ' '));
  for (const p of PARAMS) {
    const v = params[p.key] ?? p.def;
    if (p.type === 'bool') lines.push(`${p.key}=${v ? 'true' : 'false'}||false||0||true||N`);
    else { const t = numText(p, v); lines.push(`${p.key}=${t}||${t}||0||${t}||N`); }
  }
  return lines;
}

// UTF-16LE bytes with BOM, CRLF line ends.
export function buildSet(params, comments = []) {
  const text = setLines(params, comments).join('\r\n') + '\r\n';
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff; out[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[2 + i * 2] = c & 0xff;
    out[3 + i * 2] = c >> 8;
  }
  return out;
}

export function setFileName(name) {
  const base = String(name || 'preset').normalize('NFC').replace(/[\\/:*?"<>|~,]+/g, '_').replace(/\s+/g, '_')
    .replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 80) || 'preset';
  return `Dobby3_${base}.set`;
}

// Themes: every colour the website uses is a named value in app/src/styles.css, with one set of values per theme.
// This checks, with the standard contrast formula (WCAG), that in ALL FIVE themes text can be read on every surface
// and on every status colour (4.5 : 1), that the focus ring can be seen (3 : 1), and that in the four NEW themes the
// outlines of inputs and outlined buttons can be seen (3 : 1). Classic keeps the outlines version 1 had.
// It also checks that no screen sneaks in a colour of its own, which a theme could not change.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../app', import.meta.url));
const css = fs.readFileSync(path.join(APP, 'src/styles.css'), 'utf8');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', String(e.message).split('\n').slice(0, 12).join('\n       ')); } };

// ---- read the theme blocks
const END = css.indexOf('end of colours'); assert.ok(END > 0, 'styles.css must keep the "end of colours" marker');
const themes = {};
for (const m of css.slice(0, END).matchAll(/:root(?:\[data-theme="([a-z]+)"\])?\{([^}]*)\}/g)) {
  themes[m[1] || 'classic'] = Object.fromEntries([...m[2].matchAll(/(--[a-z0-9-]+):([^;]+)/g)].map((x) => [x[1], x[2].trim()]));
}
const NAMES = ['classic', 'dark', 'ocean', 'sand', 'violet'];

// ---- colour arithmetic
const parse = (v) => {
  let m = /^#([0-9a-f]{6})$/i.exec(v); if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v); if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  throw new Error('cannot read the colour ' + v);
};
const over = (top, under) => { const [r, g, b, a] = top; return [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a), 1]; };
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// text colour -> the surfaces it is written on
const TEXT = {
  '--ink': ['--bg', '--card', '--raised', '--input', '--press', '--unread', '--xbg'],
  '--muted': ['--bg', '--card', '--raised', '--press'],
  '--brand-ink': ['--brand', '--toast-err'],
  '--brand2': ['--bg', '--card', '--raised', '--press', '--unread'],
  '--brandtext': ['--bg', '--card', '--raised'],
  '--soft-ink': ['--soft'], '--chip-ink': ['--chip'],
  '--ok': ['--okbg', '--card', '--bg', '--raised'], '--warn': ['--warnbg'], '--bad': ['--badbg', '--card', '--bg', '--raised'], '--idle': ['--idlebg'], '--info': ['--infobg'],
  '--ok-ink': ['--okbg'], '--warn-ink': ['--warnbg'], '--bad-ink': ['--badbg'], '--idle-ink': ['--idlebg'],
  '--hero-ink': ['--hero', '--hero-bad', '--hero-ok'], '--hero-muted': ['--hero', '--hero-bad', '--hero-ok'], '--hero-btn-ink': ['--hero-btn'],
  '--okbtn-ink': ['--okbtn'], '--toast-ink': ['--toast'], '--accent-ink': ['--accent'],
};
// see-through layers: text, the layer, and what the layer lies on
const LAYERS = [['--hero-ink', '--hero-soft', ['--hero', '--hero-bad', '--hero-ok', '--brand']],
  ['--ok-ink', '--room-tag', ['--okbg']], ['--warn-ink', '--room-tag', ['--warnbg']], ['--bad-ink', '--room-tag', ['--badbg']], ['--idle-ink', '--room-tag', ['--idlebg']]];
const SURFACES = ['--bg', '--card', '--raised', '--input'];

console.log('Themes');
t('there are exactly five themes, and every theme gives a value to every colour name', () => {
  assert.deepEqual(Object.keys(themes), NAMES);
  const want = Object.keys(themes.classic).filter((k) => k !== '--r').sort();
  for (const n of NAMES.slice(1)) assert.deepEqual(Object.keys(themes[n]).sort(), want, n + ' has different colour names than classic');
  assert.ok(want.length > 50);
});
for (const n of NAMES) {
  const T = themes[n]; const col = (k) => { assert.ok(T[k], `${n} has no ${k}`); return parse(T[k]); };
  t(`${n}: text can be read on every surface and every status colour (4.5 : 1)`, () => {
    const bad = [];
    for (const [fg, bgs] of Object.entries(TEXT)) for (const bg of bgs) { const r = ratio(col(fg), col(bg)); if (r < 4.5) bad.push(`${fg} on ${bg} = ${r.toFixed(2)}`); }
    for (const [fg, layer, unders] of LAYERS) for (const u of unders) { const r = ratio(col(fg), over(col(layer), col(u))); if (r < 4.5) bad.push(`${fg} on ${layer} over ${u} = ${r.toFixed(2)}`); }
    assert.deepEqual(bad, []);
  });
  t(`${n}: the focus ring can be seen on every surface (3 : 1)`, () => {
    const bad = []; for (const s of SURFACES) { const r = ratio(col('--focus'), col(s)); if (r < 3) bad.push(`--focus on ${s} = ${r.toFixed(2)}`); }
    assert.deepEqual(bad, []);
  });
  if (n !== 'classic') t(`${n}: outlines of inputs, selects and outlined buttons can be seen (3 : 1)`, () => {
    const bad = []; for (const s of SURFACES) { const r = ratio(col('--ctl'), col(s)); if (r < 3) bad.push(`--ctl on ${s} = ${r.toFixed(2)}`); }
    assert.deepEqual(bad, []);
  });
}
t('classic is the look of version 1: same colours, except the three small text nudges that were just under 4.5 : 1', () => {
  const V1 = { '--bg': '#f6f3ec', '--card': '#ffffff', '--ink': '#1d2433', '--line': '#e4dfd3', '--ctl': '#e4dfd3', '--brand': '#0f4c4a', '--brand2': '#1b6b68', '--accent': '#d69e2e',
    '--okbg': '#dff3e7', '--warn': '#9a5b00', '--warnbg': '#fdecc8', '--bad': '#b42318', '--badbg': '#fde3df', '--idle': '#5b6472', '--idlebg': '#e9e6dd', '--info': '#1d4f91', '--infobg': '#e1ecfa',
    '--okbtn': '#1b7f4b', '--hero': '#0f4c4a', '--hero-bad': '#8f1d14', '--hero-ok': '#17613b', '--brandtext': '#0f4c4a', '--soft': '#e6f0ef', '--chip': '#ece8dd' };
  for (const [k, v] of Object.entries(V1)) assert.equal(themes.classic[k], v, k);
  const near = (k, old) => { const a = parse(themes.classic[k]), b = parse(old); assert.ok(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= 40, `${k} moved too far from ${old}: ${themes.classic[k]}`); };
  near('--muted', '#667085'); near('--ok', '#1b7f4b'); near('--chip-ink', '#667085');
});
t('status colours keep their meaning in every theme (green paid, amber due, red overdue, grey empty); brand colours are not green, amber or red', () => {
  const hue = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (d === 0) return -1; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
  const sat = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };
  for (const n of NAMES) {
    const T = themes[n]; const h = (k) => hue(parse(T[k]));
    assert.ok(h('--ok') > 110 && h('--ok') < 175, `${n} --ok is not green (${h('--ok')})`); assert.ok(h('--okbg') > 100 && h('--okbg') < 175, `${n} --okbg`);
    assert.ok(h('--warn') > 20 && h('--warn') < 55, `${n} --warn is not amber (${h('--warn')})`); assert.ok(h('--warnbg') > 20 && h('--warnbg') < 55, `${n} --warnbg`);
    assert.ok(h('--bad') < 20 || h('--bad') > 345, `${n} --bad is not red (${h('--bad')})`); assert.ok(h('--badbg') < 20 || h('--badbg') > 345, `${n} --badbg`);
    assert.ok(sat(parse(T['--idlebg'])) < 0.2, `${n} --idlebg is not grey`);
    const bh = h('--brand'); const isRed = bh < 15 || bh > 345, isAmber = bh >= 28 && bh <= 60, isGreen = bh > 80 && bh < 165;
    assert.ok(!isRed && !isAmber && !isGreen, `${n} brand colour looks like a status colour (hue ${bh.toFixed(0)})`);
  }
});

console.log('No colours outside the themes');
const HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b|\brgba?\(|\bhsla?\(/g;
t('styles.css: below the theme blocks every colour is a var(--name); only the print block may spell colours out (print is always light)', () => {
  const rest = css.slice(END); const printAt = rest.indexOf('@media print{'); assert.ok(printAt > 0);
  const found = rest.slice(0, printAt).match(HEX) || [];
  assert.deepEqual(found, []);
  assert.match(rest.slice(printAt), /:root,:root\[data-theme\]\{/, 'the print block must put the light colours back for every theme');
});
t('screens (.tsx/.ts): no colour is written into the code', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const bad = [];
  // lib/theme.ts is the one place that lists the themes (their names and the colour of each little swatch)
  for (const f of walk(path.join(APP, 'src')).filter((x) => /\.tsx?$/.test(x) && path.basename(x) !== 'theme.ts')) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.match(HEX) || []) bad.push(path.basename(f) + ': ' + m);
    for (const m of src.matchAll(/(?:color|background|borderColor)\s*:\s*'([^']+)'/g)) if (!/^var\(--[a-z0-9-]+\)$/.test(m[1]) && m[1] !== 'inherit' && m[1] !== 'transparent') bad.push(path.basename(f) + ': ' + m[0]);
  }
  assert.deepEqual(bad, []);
});
t('index.html: the theme is applied before the page is drawn, and the browser bar colour of each theme is that theme\'s top bar colour', () => {
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html.slice(0, html.indexOf('<div id="root">')));
  assert.ok(script, 'there must be a small inline script in <head>, before the page body');
  assert.match(script[1], /localStorage/); assert.match(script[1], /try\s*\{/); assert.match(script[1], /data-theme/); assert.match(script[1], /theme-color/);
  for (const n of NAMES) assert.ok(script[1].includes(`${n}:'${themes[n]['--brand']}'`), `the inline script should carry ${n}:'${themes[n]['--brand']}'`);
  const ts = fs.readFileSync(path.join(APP, 'src/lib/theme.ts'), 'utf8');
  for (const n of NAMES) assert.ok(ts.includes(`'${themes[n]['--brand']}'`), `theme.ts should know the bar colour of ${n}`);
});

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

// render-og.mjs — generate public/og-image.png (the social/SMS link-unfurl card).
//
// Rendered with headless Chromium so the 📌 mark renders through the SAME emoji path as the
// favicon, header, footer, and share card (a real color pushpin) — rsvg-convert can't rasterize
// color emoji, which left a broken-looking vector blob. Inter is embedded (base64) so the text
// matches the site. Re-run after any branding/tagline change:  node scripts/render-og.mjs
import { chromium } from 'playwright-core';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FONTS = join(ROOT, 'node_modules', '@fontsource', 'inter', 'files');
const b64 = (f) => readFileSync(join(FONTS, f)).toString('base64');
const inter400 = b64('inter-latin-400-normal.woff2');
const inter600 = b64('inter-latin-600-normal.woff2');
const inter700 = b64('inter-latin-700-normal.woff2');

// The favicon mark, inline and scaled to 120px. Identical geometry to public/favicon.svg; the pin
// uses the system color-emoji font so Chromium renders the real 📌 (matching every other icon).
const MARK = `
<svg width="120" height="120" viewBox="0 0 32 32" style="display:block">
  <rect width="32" height="32" fill="#ffffff"/>
  <rect x="2" y="2" width="28" height="28" fill="none" stroke="#1a1a1a" stroke-width="4"/>
  <g transform="translate(4.16, 0) rotate(25, 16, 16)">
    <text x="16" y="20" font-size="18" text-anchor="middle"
      font-family="'Noto Color Emoji','Apple Color Emoji','Segoe UI Emoji',sans-serif">📌</text>
  </g>
  <rect x="4" y="4" width="7.2" height="24" fill="#ffffff"/>
</svg>`;

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  @font-face{font-family:Inter;font-weight:400;src:url(data:font/woff2;base64,${inter400}) format('woff2')}
  @font-face{font-family:Inter;font-weight:600;src:url(data:font/woff2;base64,${inter600}) format('woff2')}
  @font-face{font-family:Inter;font-weight:700;src:url(data:font/woff2;base64,${inter700}) format('woff2')}
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:1200px;height:630px;background:#faf9f6;font-family:Inter,sans-serif;position:relative;overflow:hidden}
  .rule{position:absolute;top:0;left:0;width:1200px;height:12px;background:#d32f2f}
  .row{position:absolute;left:118px;top:200px;display:flex;align-items:center;gap:32px}
  .title{font-weight:700;font-size:96px;letter-spacing:-2px;color:#1a1a1a;line-height:1}
  .sub{position:absolute;left:120px;top:362px;color:#555;font-size:40px;line-height:1.3}
  .sub b{font-weight:700}
  .url{position:absolute;left:120px;top:540px;color:#b9b3a8;font-size:34px;font-weight:400}
</style></head><body>
  <div class="rule"></div>
  <div class="row">${MARK}<div class="title">Wall of Shame</div></div>
  <div class="sub">Search engine of harmful English language web content.<br><b>Share what makes you mad!</b></div>
  <div class="url">wallofshame.io</div>
</body></html>`;

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(ROOT, 'public', 'og-image.png'), clip: { x: 0, y: 0, width: 1200, height: 630 } });
  console.log('wrote public/og-image.png');
} finally {
  await browser.close();
}

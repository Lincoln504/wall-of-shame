/**
 * sharecard.ts — render an entry to a shareable 1080×1350 (Instagram portrait)
 * PNG, entirely client-side on a <canvas>.
 *
 * The card mirrors the web page's look: the same warm paper background, severity
 * accent, serif-free Inter type, the entry title, source, and the descriptive
 * summary (the hook, with its verbatim quote). The body is justified with the
 * Knuth-Plass algorithm (tex-linebreak + TeX en-us hyphenation), measuring with the
 * same ctx.measureText used to draw, so justification is exact. A very subtle,
 * blurred drop shadow sits under the text to give a little depth. The footer carries
 * the Wall of Shame mark and a STABLE permalink to the exact entry (by id, so it keeps
 * resolving as the corpus grows), so anyone who sees the image can find the full analysis.
 *
 * This module is loaded lazily (dynamic import on first share) so neither the fonts
 * nor tex-linebreak weigh on initial page load. It runs purely in the browser — no
 * server, no native code — which is why it is canvas/TypeScript and not napi-rs.
 */

import { layoutText, createHyphenator } from 'tex-linebreak';
import enUsPatterns from 'hyphenation.en-us';
import QRCode from 'qrcode';
import type { Finding } from './types.js';
import { stripMarkdown } from './format.js';

import in400 from '@fontsource/inter/files/inter-latin-400-normal.woff2?url';
import in600 from '@fontsource/inter/files/inter-latin-600-normal.woff2?url';
import in700 from '@fontsource/inter/files/inter-latin-700-normal.woff2?url';

const W = 1080;
const H = 1350;
const MARGIN = 84;
const CONTENT_W = W - MARGIN * 2;

const C = {
  bg: '#faf9f6',
  ink: '#1a1a1a',
  body: '#333333',
  muted: '#8a857c',
  faint: '#b9b3a8',
  divider: '#e4e1d9',
};
const SEVERITY: Record<string, string> = { high: '#d32f2f', medium: '#ef6c00', low: '#c79a00' };

const hyphenate = createHyphenator(enUsPatterns as any);

let fontsReady: Promise<void> | null = null;
function ensureFonts(): Promise<void> {
  if (!fontsReady) {
    fontsReady = (async () => {
      const defs: Array<[string, string, string]> = [
        ['Inter', in400, '400'],
        ['Inter', in600, '600'],
        ['Inter', in700, '700'],
      ];
      // Resilient: one font that fails to load must not abort the whole render —
      // the canvas falls back to the @fontsource Inter already loaded via CSS.
      await Promise.allSettled(
        defs.map(async ([family, url, weight]) => {
          const face = new FontFace(family, `url(${url})`, { weight });
          await face.load();
          (document as any).fonts.add(face);
        }),
      );
    })();
  }
  return fontsReady;
}

function categoryLabel(key: string): string {
  return key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Run `fn` with a very subtle blurred drop shadow under whatever it draws (depth). */
function withDepth(
  ctx: CanvasRenderingContext2D,
  fn: () => void,
  opts: { blur?: number; alpha?: number; dy?: number } = {},
): void {
  const { blur = 14, alpha = 0.08, dy = 5 } = opts;
  ctx.save();
  ctx.shadowColor = `rgba(20,18,16,${alpha})`;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = dy;
  fn();
  ctx.restore();
}

// Greedy word wrap (used for the title and as a fallback for the body).
function wrapGreedy(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

interface ParaLayout { draws: { t: string; x: number; line: number }[]; lines: number }

/** Lay out one paragraph with Knuth-Plass justification (greedy fallback). */
function layoutParagraph(ctx: CanvasRenderingContext2D, text: string, width: number): ParaLayout {
  const measure = (w: string) => ctx.measureText(w).width;
  try {
    const out = layoutText(text, width, measure, hyphenate);
    const draws = (out.positions as any[]).map(p => {
      const it = (out.items as any[])[p.item];
      const t = it.type === 'box' ? it.text : (it.type === 'penalty' ? '-' : '');
      return { t, x: p.xOffset, line: p.line };
    }).filter(d => d.t);
    const lines = (out.positions as any[]).reduce((m, p) => Math.max(m, p.line), 0) + 1;
    return { draws, lines };
  } catch {
    const wrapped = wrapGreedy(ctx, text, width);
    return { draws: wrapped.map((t, i) => ({ t, x: 0, line: i })), lines: wrapped.length };
  }
}

interface BodyLayout { draw: (x: number, top: number) => void; height: number }

/**
 * Lay out the summary as one justified paragraph, auto-fitting the font size so it
 * fits the available height (it is short enough that it never needs to clip).
 */
function layoutSummary(ctx: CanvasRenderingContext2D, text: string, availH: number): BodyLayout {
  const clean = stripMarkdown(text).replace(/\s+/g, ' ').trim() || ' ';
  for (let fontPx = 34; fontPx >= 22; fontPx -= 1) {
    const lineH = Math.round(fontPx * 1.5);
    ctx.font = `400 ${fontPx}px Inter, sans-serif`;
    const para = layoutParagraph(ctx, clean, CONTENT_W);
    const totalH = para.lines * lineH;
    if (totalH <= availH || fontPx === 22) {
      return {
        height: Math.min(totalH, availH),
        draw: (x, top) => {
          ctx.fillStyle = C.body;
          ctx.font = `400 ${fontPx}px Inter, sans-serif`;
          ctx.textAlign = 'left';
          withDepth(ctx, () => {
            for (const d of para.draws) {
              const yy = top + d.line * lineH + fontPx;
              if (yy <= top + availH + fontPx) ctx.fillText(d.t, x + d.x, yy);
            }
          }, { blur: 10, alpha: 0.06, dy: 4 });
        },
      };
    }
  }
  return { height: 0, draw: () => {} };
}

// Draw the Wall of Shame mark — matches favicon.svg EXACTLY (kept in lock-step with it):
// a white square, a thick dark border, the 📌 push-pin emoji tilted 25° and nudged right,
// then a white box clipping the pin's point over the left ~35% of the interior. At (x, y)
// with side `s`. The emoji is rendered with fillText (color emoji from the system font) so
// the card icon is identical to the browser-tab favicon. Drawing order mirrors the SVG:
// bg → border → pin → white clip box (interior only, so it never covers the border).
function drawMark(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  // White background fill.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, s, s);
  // Dark border matched to the favicon's visible thickness: the favicon strokes a
  // fully-visible 4px band on a 32 box (12.5%), inset. Drawing inset here at the same
  // 0.125 ratio keeps the card mark's border proportionally identical to the favicon.
  const lw = Math.max(2, s * 0.125);
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = lw;
  ctx.strokeRect(x + lw / 2, y + lw / 2, s - lw, s - lw);
  // 📌 emoji, tilted 25° about the box center (matches the favicon's rotate(25)).
  // Pin sized + shifted to match the favicon exactly: emoji ≈0.5625·s (18/32), nudged
  // 13% of the box to the RIGHT (screen-space, before the 25° rotation), so every icon in the
  // project reads identically. (favicon.svg uses translate(4.16, 0) on a 32 box = +13% x,
  // + rotate(25).)
  ctx.save();
  ctx.translate(x + s / 2 + s * 0.13, y + s / 2);
  ctx.rotate(25 * Math.PI / 180);
  ctx.font = `${Math.round(s * 0.5625)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('📌', 0, Math.round(s * 0.06));
  ctx.restore();
  // White clip box over the pin's point — the favicon's `<rect x="4" y="4" width="7.2"
  // height="24">` on the 32 box: left = inner border edge (x+lw), width 7.2/32 = 0.225·s,
  // full interior height (s − 2·lw). Interior-only so the dark border stays intact.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x + lw, y + lw, s * 0.225, s - lw * 2);
}

/**
 * Draw a QR for `text` as crisp black modules on a white tile at (x, y), side `size`.
 * Module edges are rounded to integer pixels so neighbours share a seam with no gaps or
 * bleed. A 2-module quiet zone inside the white tile lets scanners lock on. If encoding
 * ever fails it draws nothing rather than breaking the whole card.
 */
function drawQr(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, text: string) {
  let qr: ReturnType<typeof QRCode.create>;
  try { qr = QRCode.create(text, { errorCorrectionLevel: 'M' }); }
  catch { return; }
  const count = qr.modules.size;
  const data = qr.modules.data;
  const quiet = 2;
  const total = count + quiet * 2;
  const px = size / total;
  // White tile — the quiet zone + clean contrast against the warm card background.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = C.ink;
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!data[r * count + c]) continue;
      const x0 = Math.round(x + (c + quiet) * px);
      const x1 = Math.round(x + (c + quiet + 1) * px);
      const y0 = Math.round(y + (r + quiet) * px);
      const y1 = Math.round(y + (r + quiet + 1) * px);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
}

export interface ShareCardOptions {
  finding: Finding;
  page: number;
  /** Full stable permalink shown in the footer + share text, e.g. https://…/43501243 */
  pageUrl: string;
}

/** Render the card and resolve to a PNG Blob. */
export async function renderShareCard(opts: ShareCardOptions): Promise<Blob> {
  const f = opts.finding;
  const pageUrl = opts.pageUrl ?? '';
  // Defensive field reads — a finding missing any field must never throw mid-draw
  // ("undefined has no properties"); the card degrades to safe defaults instead.
  const fSeverity = f?.severity || 'low';
  const fTitle = f?.title || 'Untitled';
  const fCategory = f?.category || '';
  const fDomain = f?.domain || '';
  const fSummary = f?.summary || '';
  const fFoundAt = f?.foundAt;
  await ensureFonts();

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable'); // caught by ShareModal → graceful message
  ctx.textBaseline = 'alphabetic';

  // Background.
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // Top severity rule.
  const sev = SEVERITY[fSeverity] ?? C.muted;
  ctx.fillStyle = sev;
  ctx.fillRect(0, 0, W, 12);

  let y = MARGIN + 44;

  // Badges: severity pill + category. The severity "warning" stays at the top; the old
  // "THE WALL OF SHAME" kicker is gone (the brand now lives only in the footer).
  ctx.font = '700 26px Inter, sans-serif';
  const sevText = fSeverity.toUpperCase();
  const pillPadX = 18;
  const pillW = ctx.measureText(sevText).width + pillPadX * 2;
  const pillH = 44;
  ctx.fillStyle = sev;
  const r = 8;
  ctx.beginPath();
  if (typeof (ctx as any).roundRect === 'function') {
    (ctx as any).roundRect(MARGIN, y - pillH + 10, pillW, pillH, r);
  } else {
    ctx.rect(MARGIN, y - pillH + 10, pillW, pillH); // older browsers: square pill
  }
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(sevText, MARGIN + pillPadX, y);
  ctx.fillStyle = C.muted;
  ctx.font = '600 26px Inter, sans-serif';
  ctx.fillText(categoryLabel(fCategory).toUpperCase(), MARGIN + pillW + 22, y);
  y += 60;

  // Title (Inter bold, wrapped, max 4 lines) with a subtle depth shadow.
  ctx.fillStyle = C.ink;
  const titlePx = 52;
  const titleLineH = Math.round(titlePx * 1.16);
  ctx.font = `700 ${titlePx}px Inter, sans-serif`;
  let titleLines = wrapGreedy(ctx, fTitle, CONTENT_W);
  if (titleLines.length > 4) {
    titleLines = titleLines.slice(0, 4);
    titleLines[3] = titleLines[3].replace(/\s+\S*$/, '') + '…';
  }
  withDepth(ctx, () => {
    titleLines.forEach((ln, i) => ctx.fillText(ln, MARGIN, y + i * titleLineH + titlePx));
  }, { blur: 16, alpha: 0.1, dy: 6 });
  y += titleLines.length * titleLineH + titlePx + 8;

  // Domain (left) + the date this entry was FOUND (right). "Found" makes explicit that this
  // is the discovery date, not the article's publication date.
  ctx.fillStyle = C.muted;
  ctx.font = 'italic 400 26px Inter, sans-serif';
  ctx.fillText(fDomain, MARGIN, y);
  if (fFoundAt) {
    ctx.save();
    ctx.fillStyle = C.faint;
    ctx.font = '400 22px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`Found ${new Date(fFoundAt).toLocaleDateString()}`, W - MARGIN, y);
    ctx.restore();
  }
  y += 40;

  // Divider.
  ctx.strokeStyle = C.divider;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(MARGIN, y);
  ctx.lineTo(W - MARGIN, y);
  ctx.stroke();
  y += 48;

  // Body: the descriptive summary (the hook + its verbatim quote), justified.
  const footerRule = H - MARGIN - 192;   // divider above the footer block (room for the large pin/QR row)
  const bodyTop = y;
  const bodyAvailH = footerRule - 28 - bodyTop;
  const body = layoutSummary(ctx, fSummary, bodyAvailH);
  body.draw(MARGIN, bodyTop);

  // Footer — three elements on a shared centerline, left → right:
  //   [push-pin mark]   [QR code]   [ "More" over the permalink ]
  // The mark is sized equal to the QR; the QR is large and scannable; the permalink is the
  // ONLY full-strength black element (it is the call to action). The "Wall of Shame"
  // wordmark was removed — the mark alone now carries the brand on the card.
  ctx.strokeStyle = C.divider;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(MARGIN, footerRule);
  ctx.lineTo(W - MARGIN, footerRule);
  ctx.stroke();

  const iconS = 152;                              // pin + QR share this size (large, scannable)
  // Gap below the divider, raised to 60 so the whole footer row sits well below the line (more
  // padding); the divider (footerRule) itself stays put, and 60 keeps the row inside the canvas.
  const rowTop = footerRule + 60;
  const centerY = rowTop + iconS / 2;             // shared centerline for pin, QR, and text
  const GAP1 = 30;                                // pin → QR
  const GAP2 = 36;                                // QR → text column

  ctx.textBaseline = 'alphabetic';

  // The two text lines: muted label over the bold permalink (the call to action). Measure both so
  // the whole [pin · QR · text] group can be CENTER-justified in the card while the text lines stay
  // LEFT-aligned within their column. The link auto-shrinks to fit the column's max width.
  const label = 'Read the counter-argument at';
  const link = pageUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const maxTextW = (W - MARGIN * 2) - (iconS * 2 + GAP1 + GAP2); // text column cap when the group spans full width
  ctx.font = '600 26px Inter, sans-serif';
  const labelW = ctx.measureText(label).width;
  let linkPx = 32;
  while (linkPx > 22) {
    ctx.font = `700 ${linkPx}px Inter, sans-serif`;
    if (ctx.measureText(link).width <= maxTextW) break;
    linkPx -= 1;
  }
  const linkW = ctx.measureText(link).width;
  const textBlockW = Math.min(maxTextW, Math.max(labelW, linkW));

  // Center the whole group; never start left of MARGIN (graceful when the text block is wide).
  const groupW = iconS * 2 + GAP1 + GAP2 + textBlockW;
  const startX = Math.max(MARGIN, Math.round((W - groupW) / 2));

  drawMark(ctx, startX, rowTop, iconS);
  const qrX = startX + iconS + GAP1;
  drawQr(ctx, qrX, rowTop, iconS, pageUrl);

  const textX = qrX + iconS + GAP2;
  ctx.textAlign = 'left';
  ctx.fillStyle = C.muted;
  ctx.font = '600 26px Inter, sans-serif';
  ctx.fillText(label, textX, centerY - 8);
  ctx.font = `700 ${linkPx}px Inter, sans-serif`;
  ctx.fillStyle = C.ink;                          // full-strength black — the call to action
  ctx.fillText(link, textX, centerY + 36);

  // Export as lossy WebP (quality 0.7). For this flat-color + text + thumbnail card it keeps
  // text/edges crisp while aggressively crushing color, at a fraction of the PNG byte size.
  // Native canvas WebP encoding — zero dependencies, no COOP/COEP headers required.
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/webp', 0.7),
  );
}

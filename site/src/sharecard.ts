/**
 * sharecard.ts — render an entry to a shareable 1080×1350 (Instagram portrait)
 * PNG, entirely client-side on a <canvas>.
 *
 * The analysis body is justified with the Knuth-Plass algorithm (tex-linebreak +
 * TeX en-us hyphenation) — measuring with the same ctx.measureText used to draw,
 * so the justification is exact. Theme fonts (Newsreader serif, Inter sans) are
 * embedded via FontFace so the image renders identically on every device. The
 * footer carries the Wall-of-Shame mark and the deep link to the entry's page.
 *
 * This module is loaded lazily (dynamic import on first share) so neither the
 * fonts nor tex-linebreak weigh on initial page load.
 */

import { layoutText, createHyphenator } from 'tex-linebreak';
import enUsPatterns from 'hyphenation.en-us';
import type { Finding } from './types.js';

import nr400 from '@fontsource/newsreader/files/newsreader-latin-400-normal.woff2?url';
import nr700 from '@fontsource/newsreader/files/newsreader-latin-700-normal.woff2?url';
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
        ['Newsreader', nr400, '400'],
        ['Newsreader', nr700, '700'],
        ['Inter', in400, '400'],
        ['Inter', in600, '600'],
        ['Inter', in700, '700'],
      ];
      await Promise.all(
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

interface BodyLayout {
  draw: (x: number, top: number) => void;
  height: number;
  fontPx: number;
}

/**
 * Lay out the justified analysis body, auto-fitting the font size so it fits the
 * available height; truncates with an ellipsis if even the smallest size overflows.
 */
function layoutBody(ctx: CanvasRenderingContext2D, text: string, availH: number): BodyLayout {
  for (let fontPx = 30; fontPx >= 23; fontPx -= 1) {
    const lineH = Math.round(fontPx * 1.5);
    const maxLines = Math.max(1, Math.floor(availH / lineH));
    ctx.font = `400 ${fontPx}px Newsreader, serif`;
    const measure = (w: string) => ctx.measureText(w).width;

    let positions: { item: number; line: number; xOffset: number }[];
    let items: any[];
    try {
      const out = layoutText(text, CONTENT_W, measure, hyphenate);
      positions = out.positions as any;
      items = out.items as any;
    } catch {
      // K-P could not satisfy the spacing constraints — fall back to greedy wrap.
      const lines = wrapGreedy(ctx, text, CONTENT_W);
      const used = lines.slice(0, maxLines);
      if (used.length < lines.length) used[used.length - 1] = used[used.length - 1].replace(/\s+\S*$/, '') + ' …';
      const fits = lines.length <= maxLines;
      if (!fits && fontPx > 23) continue;
      return {
        fontPx,
        height: used.length * lineH,
        draw: (x, top) => {
          ctx.fillStyle = C.body;
          ctx.font = `400 ${fontPx}px Newsreader, serif`;
          ctx.textAlign = 'left';
          used.forEach((ln, i) => ctx.fillText(ln, x, top + i * lineH + fontPx));
        },
      };
    }

    const lineCount = positions.reduce((m, p) => Math.max(m, p.line), 0) + 1;
    if (lineCount > maxLines && fontPx > 23) continue;

    const visible = Math.min(lineCount, maxLines);
    const truncated = lineCount > maxLines;
    return {
      fontPx,
      height: visible * lineH,
      draw: (x, top) => {
        ctx.fillStyle = C.body;
        ctx.font = `400 ${fontPx}px Newsreader, serif`;
        ctx.textAlign = 'left';
        for (const p of positions) {
          if (p.line >= visible) continue;
          const it = items[p.item];
          const y = top + p.line * lineH + fontPx;
          if (it.type === 'box') ctx.fillText(it.text, x + p.xOffset, y);
          else if (it.type === 'penalty') ctx.fillText('-', x + p.xOffset, y); // hyphen at break
        }
        if (truncated) {
          ctx.fillText('…', x + CONTENT_W - ctx.measureText('…').width, top + (visible - 1) * lineH + fontPx);
        }
      },
    };
  }
  // Unreachable in practice; satisfies the type checker.
  return { fontPx: 23, height: 0, draw: () => {} };
}

// Draw the Wall-of-Shame mark (the favicon geometry) at (x, y) with side `s`.
function drawMark(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  const u = s / 32;
  ctx.fillStyle = C.ink;
  ctx.fillRect(x, y, s, s);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x + 6 * u, y + 6 * u, 20 * u, 20 * u);
  ctx.fillStyle = C.ink;
  ctx.fillRect(x + 10 * u, y + 10 * u, 12 * u, 12 * u);
}

export interface ShareCardOptions {
  finding: Finding;
  page: number;
  /** Full URL shown in the footer + the link target, e.g. https://…/#/page/10 */
  pageUrl: string;
}

/** Render the card and resolve to a PNG Blob. */
export async function renderShareCard(opts: ShareCardOptions): Promise<Blob> {
  const { finding: f, page, pageUrl } = opts;
  await ensureFonts();

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.textBaseline = 'alphabetic';

  // Background.
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // Top severity rule.
  const sev = SEVERITY[f.severity] ?? C.muted;
  ctx.fillStyle = sev;
  ctx.fillRect(0, 0, W, 12);

  let y = MARGIN + 24;

  // Kicker.
  ctx.fillStyle = C.faint;
  ctx.font = '700 24px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('THE WALL OF SHAME', MARGIN, y);
  y += 48;

  // Badges: severity pill + category.
  ctx.font = '700 26px Inter, sans-serif';
  const sevText = f.severity.toUpperCase();
  const pillPadX = 18;
  const pillW = ctx.measureText(sevText).width + pillPadX * 2;
  const pillH = 44;
  ctx.fillStyle = sev;
  const r = 8;
  ctx.beginPath();
  ctx.roundRect(MARGIN, y - pillH + 10, pillW, pillH, r);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(sevText, MARGIN + pillPadX, y);
  ctx.fillStyle = C.muted;
  ctx.font = '600 26px Inter, sans-serif';
  ctx.fillText(categoryLabel(f.category).toUpperCase(), MARGIN + pillW + 22, y);
  y += 60;

  // Title (Newsreader bold, wrapped, max 4 lines).
  ctx.fillStyle = C.ink;
  const titlePx = 56;
  const titleLineH = Math.round(titlePx * 1.12);
  ctx.font = `700 ${titlePx}px Newsreader, serif`;
  let titleLines = wrapGreedy(ctx, f.title, CONTENT_W);
  if (titleLines.length > 4) {
    titleLines = titleLines.slice(0, 4);
    titleLines[3] = titleLines[3].replace(/\s+\S*$/, '') + '…';
  }
  titleLines.forEach((ln, i) => ctx.fillText(ln, MARGIN, y + i * titleLineH + titlePx));
  y += titleLines.length * titleLineH + titlePx + 8;

  // Domain.
  ctx.fillStyle = C.muted;
  ctx.font = 'italic 400 28px Newsreader, serif';
  ctx.fillText(f.domain, MARGIN, y);
  y += 40;

  // Divider.
  ctx.strokeStyle = C.divider;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(MARGIN, y);
  ctx.lineTo(W - MARGIN, y);
  ctx.stroke();
  y += 44;

  // "Analysis" label.
  ctx.fillStyle = sev;
  ctx.font = '700 24px Inter, sans-serif';
  ctx.fillText('ANALYSIS', MARGIN, y);
  y += 40;

  // Footer geometry (reserve space at the bottom).
  const footerY = H - MARGIN - 16;
  const bodyTop = y;
  const bodyAvailH = footerY - 70 - bodyTop;

  const body = layoutBody(ctx, f.whyBad, bodyAvailH);
  body.draw(MARGIN, bodyTop);

  // Footer: mark + url/page.
  ctx.strokeStyle = C.divider;
  ctx.beginPath();
  ctx.moveTo(MARGIN, footerY - 56);
  ctx.lineTo(W - MARGIN, footerY - 56);
  ctx.stroke();

  drawMark(ctx, MARGIN, footerY - 38, 40);
  ctx.fillStyle = C.ink;
  ctx.font = '700 27px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Wall of Shame', MARGIN + 56, footerY - 16);

  ctx.fillStyle = C.muted;
  ctx.font = '400 24px Inter, sans-serif';
  const foot = pageUrl.replace(/^https?:\/\//, '');
  ctx.textAlign = 'right';
  ctx.fillText(foot, W - MARGIN, footerY - 16);
  void page;

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  );
}

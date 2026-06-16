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
 * the Wall-of-Shame mark and the deep link to the exact page the entry lives on, so
 * anyone who sees the image can find the full analysis.
 *
 * This module is loaded lazily (dynamic import on first share) so neither the fonts
 * nor tex-linebreak weigh on initial page load. It runs purely in the browser — no
 * server, no native code — which is why it is canvas/TypeScript and not napi-rs.
 */

import { layoutText, createHyphenator } from 'tex-linebreak';
import enUsPatterns from 'hyphenation.en-us';
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
  const { finding: f, pageUrl } = opts;
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
  ctx.fillText(categoryLabel(f.category).toUpperCase(), MARGIN + pillW + 22, y);
  y += 60;

  // Title (Inter bold, wrapped, max 4 lines) with a subtle depth shadow.
  ctx.fillStyle = C.ink;
  const titlePx = 52;
  const titleLineH = Math.round(titlePx * 1.16);
  ctx.font = `700 ${titlePx}px Inter, sans-serif`;
  let titleLines = wrapGreedy(ctx, f.title, CONTENT_W);
  if (titleLines.length > 4) {
    titleLines = titleLines.slice(0, 4);
    titleLines[3] = titleLines[3].replace(/\s+\S*$/, '') + '…';
  }
  withDepth(ctx, () => {
    titleLines.forEach((ln, i) => ctx.fillText(ln, MARGIN, y + i * titleLineH + titlePx));
  }, { blur: 16, alpha: 0.1, dy: 6 });
  y += titleLines.length * titleLineH + titlePx + 8;

  // Domain.
  ctx.fillStyle = C.muted;
  ctx.font = 'italic 400 26px Inter, sans-serif';
  ctx.fillText(f.domain, MARGIN, y);
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
  const footerY = H - MARGIN - 16;
  const bodyTop = y;
  const bodyAvailH = footerY - 70 - bodyTop;
  const body = layoutSummary(ctx, f.summary, bodyAvailH);
  body.draw(MARGIN, bodyTop);

  // Footer: mark + url/page (the deep link to the entry's page).
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

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  );
}

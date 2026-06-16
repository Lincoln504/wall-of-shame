/**
 * share.ts — turn an entry into a shareable image and hand it to the OS share
 * sheet (Web Share API Level 2) or download it as a fallback.
 *
 * The heavy renderer (tex-linebreak + embedded fonts) is dynamically imported on
 * first use so it never weighs on initial page load. The card image is built
 * first, then `navigator.canShare({ files })` decides between the native share
 * sheet (mobile Chrome/Android, iOS Safari, some desktop) and a download (Firefox,
 * most desktop). The actual `navigator.share` call stays inside the click's user
 * activation, so it must be awaited promptly after the blob is ready.
 */

import type { Finding } from './types.js';

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'entry';
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export type ShareResult = 'shared' | 'downloaded' | 'cancelled' | 'error';

/**
 * Generate the share card for `finding` (which lives on `page`, reachable at
 * `pageUrl`) and share or download it.
 */
export async function shareFinding(finding: Finding, page: number, pageUrl: string): Promise<ShareResult> {
  let blob: Blob;
  try {
    const { renderShareCard } = await import('./sharecard.js');
    blob = await renderShareCard({ finding, page, pageUrl });
  } catch (err) {
    console.error('share card render failed:', err);
    return 'error';
  }

  const filename = `wall-of-shame-${slugify(finding.title)}.png`;
  const file = new File([blob], filename, { type: 'image/png' });
  const nav = navigator as any;

  if (nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await nav.share({
        files: [file],
        title: finding.title,
        text: `${finding.title} — on the Wall of Shame\n${pageUrl}`,
      });
      return 'shared';
    } catch (err: any) {
      if (err && err.name === 'AbortError') return 'cancelled';
      // Fall through to download on any non-cancel share failure.
    }
  }

  download(blob, filename);
  return 'downloaded';
}

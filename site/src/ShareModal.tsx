import { createSignal, Show, onCleanup, createEffect, on } from 'solid-js';
import type { Finding } from './types.js';

interface Props {
  finding: Finding | null;
  page: number;
  pageUrl: string;
  onClose: () => void;
}

/**
 * Share modal — image + buttons only (no header, no captions).
 *
 * The SHARE button picks its path by CAPABILITY, not by guessing the device:
 *  - If the browser supports the Web Share API for files (navigator.canShare({files})),
 *    the button opens the native OS share sheet with the generated PNG. This works on
 *    mobile AND on Web-Share-capable desktops (Chrome/Edge) — wherever it works, we use it.
 *  - Otherwise (e.g. desktop Firefox) it falls back to sharing the LINK by EMAIL via a
 *    prefilled mailto:. A runtime try/catch ALSO falls back if share() throws/blocks, so
 *    an unsupported or denied share never dead-ends.
 *
 * Copy link shows everywhere. Download shows on DESKTOP only (mobile users save straight
 * from the share sheet). The entry's stable permalink rides in the share text / email body
 * and is printed in the image footer. Built on the native <dialog> for a free focus-trap,
 * Esc-to-close and backdrop; centered explicitly so it can't drift to a corner.
 */

/** Coarse mobile/tablet detection — only used to decide whether to show Download. */
function isMobileDevice(): boolean {
  const uaData = (navigator as any).userAgentData;
  if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile;
  const ua = navigator.userAgent || '';
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /Android|iPhone|iPod|iPad|Mobile/i.test(ua) || iPadOS;
}

export default function ShareModal(props: Props) {
  let dialogRef: HTMLDialogElement | undefined;
  const [blob, setBlob] = createSignal<Blob | null>(null);
  const [imgUrl, setImgUrl] = createSignal('');
  const [status, setStatus] = createSignal('');
  const [generating, setGenerating] = createSignal(false);
  const mobile = isMobileDevice();

  // The live object URL is held in a PLAIN variable — never read it reactively, or the
  // generating effect would depend on imgUrl and re-run, revoking each fresh blob.
  let objUrl = '';
  const revoke = () => { if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = ''; } };
  onCleanup(revoke);

  // Open + (re)generate ONLY when the finding changes. The blob is ready before the user
  // can click Share, so the share handler never awaits work that would drop user activation.
  createEffect(on(() => props.finding, (f) => {
    if (!f) return;
    // showModal can throw (already-open, not-connected) — guard it so the effect never
    // throws uncaught (which would tear down the app). A failed open just leaves the modal
    // closed; the render below still runs.
    try { if (dialogRef && !dialogRef.open) dialogRef.showModal(); } catch { /* leave closed */ }
    revoke();
    setBlob(null); setImgUrl(''); setStatus(''); setGenerating(true);
    void (async () => {
      try {
        const { renderShareCard } = await import('./sharecard.js');
        const b = await renderShareCard({ finding: f, page: props.page, pageUrl: props.pageUrl });
        objUrl = URL.createObjectURL(b);
        setBlob(b);
        setImgUrl(objUrl);
      } catch (e) {
        console.error('share card render failed:', e);
        setStatus('Could not generate the image.');
      } finally { setGenerating(false); }
    })();
  }));

  const close = () => { revoke(); setImgUrl(''); dialogRef?.close(); props.onClose(); };

  const flash = (m: string) => { setStatus(m); window.setTimeout(() => setStatus(s => (s === m ? '' : s)), 2500); };
  // Short, clean download name: wos-<4 hex>.png. The 4-char tag (from the entry id) just
  // keeps multiple saved cards distinct; filename collisions are harmless (the browser
  // de-dupes), so 4 is plenty.
  const fileName = () => {
    const tag = (props.finding?.id || '').replace(/[^a-f0-9]/gi, '').slice(0, 4);
    return tag ? `wos-${tag}.webp` : 'wos.webp';
  };
  const fileOf = (b: Blob) => new File([b], fileName(), { type: 'image/webp' });

  // Capability check for the native file-share path (mobile + Web-Share-capable desktops).
  const canWebShare = () => {
    const b = blob(); if (!b) return false;
    try { return !!(navigator as any).canShare?.({ files: [fileOf(b)] }); }
    catch { return false; }
  };

  const shareText = () => `${props.finding?.title ?? ''} — on Wall of Shame\n${props.pageUrl}`;
  const mailtoHref = () => {
    const subject = props.finding?.title ?? 'Wall of Shame';
    const body = `Flagged on Wall of Shame:\n\n${props.finding?.title ?? ''}\n${props.pageUrl}\n\nThe full breakdown is at the link above.`;
    return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(props.pageUrl); flash('Link copied.'); }
    catch { flash('Copy failed.'); }
  };

  // Native share sheet with the image. try/catch detects an unsupported/blocked share at
  // runtime (the user's "use a try/catch for whether it's supported") and falls back to
  // copying the link, so the button never silently fails.
  const shareNative = async () => {
    const b = blob(); if (!b) { flash('Still generating…'); return; }
    try {
      await (navigator as any).share({ files: [fileOf(b)], title: props.finding?.title, text: shareText() });
    } catch (e: any) {
      if (e?.name === 'AbortError') return;              // user dismissed the sheet — fine
      flash('Share unavailable — link copied instead.');
      try { await navigator.clipboard.writeText(props.pageUrl); } catch { /* best effort */ }
    }
  };

  const downloadImage = () => {
    const b = blob(); if (!b) return;
    const u = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = u; a.download = fileName();
    a.click(); URL.revokeObjectURL(u);
    flash('Downloaded.');
  };

  return (
    <dialog
      ref={dialogRef}
      style={st.dialog}
      onClose={() => props.onClose()}
      onClick={e => { if (e.target === dialogRef) close(); }}
    >
      <button style={st.x} onClick={close} aria-label="Close">✕</button>

      <div style={st.preview}>
        <Show when={imgUrl()} fallback={<div style={st.skeleton}>{generating() ? 'Generating image…' : (status() || '…')}</div>}>
          <img src={imgUrl()} alt="Share card preview" style={st.img} />
        </Show>
      </div>

      <div style={st.row}>
        <Show
          when={canWebShare()}
          fallback={<a style={{ ...st.btn, ...st.primary }} href={mailtoHref()} target="_blank" rel="noopener noreferrer" onClick={() => flash('Opening your email…')}>Email link</a>}
        >
          <button style={{ ...st.btn, ...st.primary }} disabled={!blob()} onClick={shareNative}>Share</button>
        </Show>
        <button style={st.btn} disabled={!props.pageUrl} onClick={copyLink}>Copy link</button>
        <Show when={!mobile}>
          <button style={st.btn} disabled={!blob()} onClick={downloadImage}>Download</button>
        </Show>
      </div>

      <Show when={status()}><div style={st.status}>{status()}</div></Show>
    </dialog>
  );
}

const st: Record<string, any> = {
  dialog: {
    // Explicit centering so a margin reset (or anything else) can't pin it to a corner.
    position: 'fixed', inset: '0', margin: 'auto',
    border: 'none', 'border-radius': '14px', padding: '1.25rem', 'max-width': '380px', width: '92vw',
    'box-shadow': '0 20px 60px rgba(0,0,0,0.3)', color: '#1a1a1a',
    'font-family': 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
  },
  x: { position: 'absolute', top: '0.5rem', right: '0.6rem', border: 'none', background: 'none', 'font-size': '1.05rem', cursor: 'pointer', color: '#bbb', 'line-height': 1, padding: '0.2rem 0.35rem', 'z-index': 1 },
  preview: { display: 'flex', 'justify-content': 'center', 'margin-bottom': '1rem' },
  img: { width: '240px', 'max-width': '100%', height: 'auto', 'border-radius': '8px', border: '1px solid #eee', 'box-shadow': '0 4px 16px rgba(0,0,0,0.12)' },
  skeleton: { width: '240px', height: '300px', display: 'flex', 'align-items': 'center', 'justify-content': 'center', background: '#f4f3ef', 'border-radius': '8px', color: '#999', 'font-size': '0.85rem' },
  row: { display: 'flex', gap: '0.5rem', 'justify-content': 'center', 'flex-wrap': 'wrap' },
  btn: { 'font-family': 'Inter, sans-serif', 'font-size': '0.85rem', 'font-weight': '600', padding: '0.55rem 1rem', 'border-radius': '8px', border: '1px solid #ddd', background: '#fff', color: '#1a1a1a', cursor: 'pointer', 'text-decoration': 'none', display: 'inline-block' },
  primary: { background: '#1a1a1a', color: '#fff', 'border-color': '#1a1a1a' },
  status: { 'font-size': '0.78rem', color: '#1a7f37', 'text-align': 'center', 'margin-top': '0.7rem', 'font-weight': '600' },
};

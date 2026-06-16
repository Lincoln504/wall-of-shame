import { createSignal, Show, onCleanup, createEffect, on } from 'solid-js';
import type { Finding } from './types.js';

interface Props {
  finding: Finding | null;
  page: number;
  pageUrl: string;
  onClose: () => void;
}

/**
 * Share modal. Two device-appropriate paths, chosen by FEATURE DETECTION (never
 * user-agent sniffing), using only W3C-standard browser APIs — no third-party
 * libraries, so no licensing concerns:
 *
 *  - MOBILE / anything that can share files (navigator.canShare({files})) → the
 *    native OS share sheet with the generated PNG (Messages/SMS, Instagram, X…).
 *  - DESKTOP / no file sharing → share the LINK by EMAIL via a prefilled mailto:
 *    (the web-native "email API"), opened in the user's mail client, plus Copy link.
 *
 * The entry's deep link rides in the share text / email body and is printed in the
 * image footer. Built on the native <dialog> for a free focus-trap, Esc-to-close,
 * and backdrop; centered explicitly so it can't drift to a corner.
 */
export default function ShareModal(props: Props) {
  let dialogRef: HTMLDialogElement | undefined;
  const [blob, setBlob] = createSignal<Blob | null>(null);
  const [imgUrl, setImgUrl] = createSignal('');
  const [status, setStatus] = createSignal('');
  const [generating, setGenerating] = createSignal(false);

  // The live object URL is held in a PLAIN variable — never read it reactively, or the
  // generating effect would depend on imgUrl and re-run, revoking each fresh blob (the
  // bug that left the preview stuck on "…").
  let objUrl = '';
  const revoke = () => { if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = ''; } };
  onCleanup(revoke);

  // Open + (re)generate ONLY when the finding changes (on() scopes the dependency so the
  // effect never re-fires on its own imgUrl/status writes).
  createEffect(on(() => props.finding, (f) => {
    if (!f) return;
    if (dialogRef && !dialogRef.open) dialogRef.showModal();
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
  const fileOf = (b: Blob) => new File([b], 'wall-of-shame.png', { type: 'image/png' });

  // Feature-detect the file-sharing path (mobile). Drives which buttons show.
  const canShareImage = () => {
    const b = blob(); if (!b) return false;
    try { return !!(navigator as any).canShare?.({ files: [fileOf(b)] }); }
    catch { return false; }
  };

  const shareText = () => `${props.finding?.title ?? ''} — on the Wall of Shame\n${props.pageUrl}`;
  const mailtoHref = () => {
    const subject = `${props.finding?.title ?? 'Wall of Shame'} — Wall of Shame`;
    const body = `Flagged on the Wall of Shame:\n\n${props.finding?.title ?? ''}\n${props.pageUrl}\n\nThe full breakdown is at the link above.`;
    return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  // Mobile: native share sheet with the image. Must run inside this click (user activation).
  const shareImage = async () => {
    const b = blob(); if (!b) return;
    const file = fileOf(b);
    const nav = navigator as any;
    if (nav.canShare && nav.canShare({ files: [file] })) {
      try { await nav.share({ files: [file], title: props.finding?.title, text: shareText() }); }
      catch (e: any) { if (e?.name !== 'AbortError') downloadImage(); }
    } else downloadImage();
  };
  const copyImage = async () => {
    const b = blob(); if (!b) return;
    try {
      await (navigator as any).clipboard.write([new ClipboardItem({ 'image/png': b })]);
      flash('Image copied — paste into a post or message.');
    } catch { flash('Copy image unsupported — use Download.'); }
  };
  const downloadImage = () => {
    const b = blob(); if (!b) return;
    const u = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = u; a.download = 'wall-of-shame.png';
    a.click(); URL.revokeObjectURL(u);
    flash('Downloaded.');
  };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(props.pageUrl); flash('Link copied.'); }
    catch { flash('Copy failed.'); }
  };

  return (
    <dialog
      ref={dialogRef}
      style={st.dialog}
      onClose={() => props.onClose()}
      onClick={e => { if (e.target === dialogRef) close(); }}
    >
      <div style={st.head}>
        <span style={st.title}>Share entry</span>
        <button style={st.x} onClick={close} aria-label="Close">✕</button>
      </div>

      <div style={st.preview}>
        <Show when={imgUrl()} fallback={<div style={st.skeleton}>{generating() ? 'Generating image…' : (status() || '…')}</div>}>
          <img src={imgUrl()} alt="Share card preview" style={st.img} />
        </Show>
      </div>

      <Show
        when={canShareImage()}
        fallback={
          <>
            <div style={st.row}>
              <a style={{ ...st.btn, ...st.primary }} href={mailtoHref()} target="_blank" rel="noopener noreferrer" onClick={() => flash('Opening your email…')}>Email link</a>
              <button style={st.btn} disabled={!props.pageUrl} onClick={copyLink}>Copy link</button>
              <button style={st.btn} disabled={!blob()} onClick={downloadImage}>Download image</button>
            </div>
            <p style={st.note}>On desktop we share the link by email; the image is yours to download.</p>
          </>
        }
      >
        <div style={st.row}>
          <button style={{ ...st.btn, ...st.primary }} disabled={!blob()} onClick={shareImage}>Share image</button>
          <button style={st.btn} disabled={!blob()} onClick={copyImage}>Copy image</button>
        </div>
        <p style={st.note}>Shares the image to your phone's share sheet — Messages, Instagram, X, and the rest. The link to this entry is included.</p>
      </Show>

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
  head: { display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', 'margin-bottom': '0.9rem' },
  title: { 'font-weight': '700', 'font-size': '1.05rem' },
  x: { border: 'none', background: 'none', 'font-size': '1.1rem', cursor: 'pointer', color: '#888', padding: '0.2rem 0.4rem' },
  preview: { display: 'flex', 'justify-content': 'center', 'margin-bottom': '1rem' },
  img: { width: '240px', 'max-width': '100%', height: 'auto', 'border-radius': '8px', border: '1px solid #eee', 'box-shadow': '0 4px 16px rgba(0,0,0,0.12)' },
  skeleton: { width: '240px', height: '300px', display: 'flex', 'align-items': 'center', 'justify-content': 'center', background: '#f4f3ef', 'border-radius': '8px', color: '#999', 'font-size': '0.85rem' },
  row: { display: 'flex', gap: '0.5rem', 'justify-content': 'center', 'flex-wrap': 'wrap' },
  btn: { 'font-family': 'Inter, sans-serif', 'font-size': '0.85rem', 'font-weight': '600', padding: '0.55rem 1rem', 'border-radius': '8px', border: '1px solid #ddd', background: '#fff', color: '#1a1a1a', cursor: 'pointer', 'text-decoration': 'none', display: 'inline-block' },
  primary: { background: '#1a1a1a', color: '#fff', 'border-color': '#1a1a1a' },
  note: { 'font-size': '0.72rem', color: '#999', 'line-height': 1.5, 'margin-top': '0.9rem', 'text-align': 'center' },
  status: { 'font-size': '0.78rem', color: '#1a7f37', 'text-align': 'center', 'margin-top': '0.5rem', 'font-weight': '600' },
};

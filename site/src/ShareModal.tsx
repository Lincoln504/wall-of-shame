import { createSignal, Show, onCleanup, createEffect } from 'solid-js';
import type { Finding } from './types.js';

interface Props {
  finding: Finding | null;
  page: number;
  pageUrl: string;
  onClose: () => void;
}

/**
 * Share modal: previews the generated 1080×1350 card, then shares the IMAGE itself
 * through the device's native share sheet (navigator.share with a file) — which on a
 * phone surfaces Messages/SMS, Instagram, X, WhatsApp, AirDrop, and everything else
 * the OS offers, with no per-platform buttons to maintain. The entry's deep link
 * travels in the share text and is also printed in the image footer.
 *
 * The Web Share API with files isn't available on every desktop browser, so when it
 * isn't, we fall back to Download / Copy image. Built on the native <dialog> for a
 * free focus-trap, Esc-to-close, and backdrop.
 */
export default function ShareModal(props: Props) {
  let dialogRef: HTMLDialogElement | undefined;
  const [blob, setBlob] = createSignal<Blob | null>(null);
  const [imgUrl, setImgUrl] = createSignal('');
  const [status, setStatus] = createSignal('');
  const [generating, setGenerating] = createSignal(false);

  const cleanupUrl = () => { const u = imgUrl(); if (u) URL.revokeObjectURL(u); };
  onCleanup(cleanupUrl);

  // Open + (re)generate whenever a finding is supplied.
  createEffect(() => {
    const f = props.finding;
    if (!f) return;
    if (dialogRef && !dialogRef.open) dialogRef.showModal();
    cleanupUrl();
    setBlob(null); setImgUrl(''); setStatus(''); setGenerating(true);
    void (async () => {
      try {
        const { renderShareCard } = await import('./sharecard.js');
        const b = await renderShareCard({ finding: f, page: props.page, pageUrl: props.pageUrl });
        setBlob(b);
        setImgUrl(URL.createObjectURL(b));
      } catch (e) {
        console.error('share card render failed:', e);
        setStatus('Could not generate the image.');
      } finally { setGenerating(false); }
    })();
  });

  const close = () => { cleanupUrl(); setImgUrl(''); dialogRef?.close(); props.onClose(); };

  const shareText = () => `${props.finding?.title ?? ''} — on the Wall of Shame\n${props.pageUrl}`;
  const flash = (m: string) => { setStatus(m); window.setTimeout(() => setStatus(s => (s === m ? '' : s)), 2500); };

  const fileOf = (b: Blob) => new File([b], 'wall-of-shame.png', { type: 'image/png' });

  const canShareImage = () => {
    const b = blob(); if (!b) return false;
    try { return !!(navigator as any).canShare?.({ files: [fileOf(b)] }); }
    catch { return false; }
  };

  const downloadImage = () => {
    const b = blob(); if (!b) return;
    const u = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = u; a.download = 'wall-of-shame.png';
    a.click(); URL.revokeObjectURL(u);
    flash('Downloaded.');
  };
  // Native share — must run inside this click (transient user activation).
  const shareImage = async () => {
    const b = blob(); if (!b) return;
    const file = fileOf(b);
    const nav = navigator as any;
    if (nav.canShare && nav.canShare({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: props.finding?.title, text: shareText() });
      } catch (e: any) {
        if (e?.name !== 'AbortError') downloadImage();
      }
    } else {
      downloadImage();
    }
  };
  const copyImage = async () => {
    const b = blob(); if (!b) return;
    try {
      await (navigator as any).clipboard.write([new ClipboardItem({ 'image/png': b })]);
      flash('Image copied — paste into a post or message.');
    } catch { flash('Copy image unsupported — use Download.'); }
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

      <div style={st.row}>
        <Show
          when={canShareImage()}
          fallback={<button style={{ ...st.btn, ...st.primary }} disabled={!blob()} onClick={downloadImage}>Download image</button>}
        >
          <button style={{ ...st.btn, ...st.primary }} disabled={!blob()} onClick={shareImage}>Share image</button>
        </Show>
        <button style={st.btn} disabled={!blob()} onClick={copyImage}>Copy image</button>
        <Show when={canShareImage()}>
          <button style={st.btn} disabled={!blob()} onClick={downloadImage}>Download</button>
        </Show>
      </div>

      <p style={st.note}>
        Shares the image straight to your phone's share sheet — Messages, Instagram, X, and the rest.
        The link to this entry's page is included with it.
      </p>
      <Show when={status()}><div style={st.status}>{status()}</div></Show>
    </dialog>
  );
}

const st: Record<string, any> = {
  dialog: {
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
  btn: { 'font-family': 'Inter, sans-serif', 'font-size': '0.85rem', 'font-weight': '600', padding: '0.55rem 1rem', 'border-radius': '8px', border: '1px solid #ddd', background: '#fff', color: '#1a1a1a', cursor: 'pointer' },
  primary: { background: '#1a1a1a', color: '#fff', 'border-color': '#1a1a1a' },
  note: { 'font-size': '0.72rem', color: '#999', 'line-height': 1.5, 'margin-top': '0.9rem', 'text-align': 'center' },
  status: { 'font-size': '0.78rem', color: '#1a7f37', 'text-align': 'center', 'margin-top': '0.5rem', 'font-weight': '600' },
};

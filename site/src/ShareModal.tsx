import { createSignal, Show, For, onCleanup, createEffect } from 'solid-js';
import { siX, siFacebook, siReddit, siWhatsapp, siTelegram, siBluesky } from 'simple-icons';
import type { Finding } from './types.js';

// LinkedIn was removed from simple-icons (brand policy), so inline its glyph.
const siLinkedin = {
  hex: '0A66C2',
  path: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z',
};

interface Props {
  finding: Finding | null;
  page: number;
  pageUrl: string;
  onClose: () => void;
}

/**
 * Share modal: previews the generated 1080×1350 card, then offers actions.
 *
 * Two honestly-separated mechanisms (web reality): the IMAGE actions (native
 * Share / Download / Copy image) move the actual PNG; the platform buttons share
 * a LINK to the entry's page (its preview thumbnail comes from the page's Open
 * Graph image, not the PNG). Built on the native <dialog> for free focus-trap,
 * Esc-to-close, and backdrop.
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

  const text = () => `${props.finding?.title ?? ''} — on the Wall of Shame`;
  const U = () => encodeURIComponent(props.pageUrl);
  const T = () => encodeURIComponent(text());
  const TU = () => encodeURIComponent(`${text()} ${props.pageUrl}`);

  const platforms = () => [
    { name: 'X', icon: siX, url: `https://x.com/intent/tweet?text=${T()}&url=${U()}` },
    { name: 'Reddit', icon: siReddit, url: `https://www.reddit.com/submit?url=${U()}&title=${T()}` },
    { name: 'WhatsApp', icon: siWhatsapp, url: `https://api.whatsapp.com/send?text=${TU()}` },
    { name: 'Telegram', icon: siTelegram, url: `https://t.me/share/url?url=${U()}&text=${T()}` },
    { name: 'Bluesky', icon: siBluesky, url: `https://bsky.app/intent/compose?text=${TU()}` },
    { name: 'Facebook', icon: siFacebook, url: `https://www.facebook.com/sharer/sharer.php?u=${U()}` },
    { name: 'LinkedIn', icon: siLinkedin, url: `https://www.linkedin.com/sharing/share-offsite/?url=${U()}` },
  ];

  const flash = (m: string) => { setStatus(m); window.setTimeout(() => setStatus(s => (s === m ? '' : s)), 2500); };

  const downloadImage = () => {
    const b = blob(); if (!b) return;
    const u = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = u; a.download = 'wall-of-shame.png';
    a.click(); URL.revokeObjectURL(u);
    flash('Downloaded.');
  };
  const shareImage = async () => {
    const b = blob(); if (!b) return;
    const file = new File([b], 'wall-of-shame.png', { type: 'image/png' });
    const nav = navigator as any;
    if (nav.canShare && nav.canShare({ files: [file] })) {
      try { await nav.share({ files: [file], title: props.finding?.title, text: text() }); }
      catch (e: any) { if (e?.name !== 'AbortError') downloadImage(); }
    } else downloadImage();
  };
  const copyImage = async () => {
    const b = blob(); if (!b) return;
    try {
      await (navigator as any).clipboard.write([new ClipboardItem({ 'image/png': b })]);
      flash('Image copied — paste into a post.');
    } catch { flash('Copy image unsupported — use Download.'); }
  };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(props.pageUrl); flash('Link copied.'); }
    catch { flash('Copy failed.'); }
  };
  const openIntent = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');

  const canShareImage = () => {
    const b = blob(); if (!b) return false;
    try { return !!(navigator as any).canShare?.({ files: [new File([b], 'x.png', { type: 'image/png' })] }); }
    catch { return false; }
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
        <Show when={canShareImage()}>
          <button style={{ ...st.btn, ...st.primary }} disabled={!blob()} onClick={shareImage}>Share image</button>
        </Show>
        <button style={st.btn} disabled={!blob()} onClick={downloadImage}>Download</button>
        <button style={st.btn} disabled={!blob()} onClick={copyImage}>Copy image</button>
      </div>

      <div style={st.divider} />

      <div style={st.platRow}>
        <For each={platforms()}>
          {p => (
            <button
              style={{ ...st.iconBtn, background: `#${p.icon.hex}` }}
              title={`Share a link on ${p.name}`}
              aria-label={`Share on ${p.name}`}
              onClick={() => openIntent(p.url)}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="#fff"><path d={p.icon.path} /></svg>
            </button>
          )}
        </For>
        <button style={st.copyLink} onClick={copyLink}>Copy link</button>
      </div>

      <p style={st.note}>
        Image buttons move the picture itself. Platform buttons share a <em>link</em> to this entry's
        page — the preview image there comes from the page, not the card above.
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
  btn: { 'font-family': 'Inter, sans-serif', 'font-size': '0.85rem', 'font-weight': '600', padding: '0.5rem 0.9rem', 'border-radius': '8px', border: '1px solid #ddd', background: '#fff', color: '#1a1a1a', cursor: 'pointer' },
  primary: { background: '#1a1a1a', color: '#fff', 'border-color': '#1a1a1a' },
  divider: { height: '1px', background: '#eee', margin: '1rem 0' },
  platRow: { display: 'flex', gap: '0.45rem', 'justify-content': 'center', 'align-items': 'center', 'flex-wrap': 'wrap' },
  iconBtn: { width: '36px', height: '36px', 'border-radius': '50%', border: 'none', cursor: 'pointer', display: 'inline-flex', 'align-items': 'center', 'justify-content': 'center' },
  copyLink: { 'font-family': 'Inter, sans-serif', 'font-size': '0.8rem', 'font-weight': '600', padding: '0.45rem 0.8rem', 'border-radius': '8px', border: '1px solid #ddd', background: '#fff', color: '#1a1a1a', cursor: 'pointer' },
  note: { 'font-size': '0.72rem', color: '#999', 'line-height': 1.5, 'margin-top': '0.9rem', 'text-align': 'center' },
  status: { 'font-size': '0.78rem', color: '#1a7f37', 'text-align': 'center', 'margin-top': '0.5rem', 'font-weight': '600' },
};

// Large photo preview with previous / next (buttons, arrow keys, swipe) and optional actions under the photo.
import { useEffect, useRef } from 'react';
import { Dialog, Icon } from '../ui.jsx';

export default function PhotoViewer({ photos, index, onIndex, onClose, srcOf, actions }) {
  const open = index !== null && index >= 0 && index < photos.length;
  const ph = open ? photos[index] : null;
  const touch = useRef(null);
  const go = (d) => { if (open) onIndex((index + d + photos.length) % photos.length); };
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={open} onClose={onClose} title={ph ? `Photo ${index + 1} of ${photos.length}` : 'Photo'} wide>
      {ph && (
        <div className="pviewer">
          <div className="pv-stage" onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
            onTouchEnd={(e) => { const dx = e.changedTouches[0].clientX - (touch.current ?? 0); if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); touch.current = null; }}>
            <img src={srcOf(ph)} alt={ph.name} />
            {photos.length > 1 && <>
              <button type="button" className="pv-nav prev" onClick={() => go(-1)} aria-label="Previous photo"><Icon name="back" size={22} /></button>
              <button type="button" className="pv-nav next" onClick={() => go(1)} aria-label="Next photo"><Icon name="back" size={22} style={{ transform: 'scaleX(-1)' }} /></button>
            </>}
          </div>
          <div className="spread pv-foot">
            <span className="small muted" style={{ wordBreak: 'break-all' }}>{ph.name}</span>
            {actions && <div className="row tight">{actions(ph)}</div>}
          </div>
          {photos.length > 1 && (
            <div className="pv-strip">
              {photos.map((p, i) => (
                <button type="button" key={p.id || p.url} className={i === index ? 'on' : ''} onClick={() => onIndex(i)} aria-label={`Photo ${i + 1}`}>
                  <img src={srcOf(p)} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

import { useEffect } from 'react';
import { Mark, Wordmark } from '../ui.jsx';
import { DIFFERENT, FEATURES, GUIDE } from '../guide-content.js';

// Public user guide (/help). The same page prints as the PDF manual (scripts/guide/manual-pdf.mjs).
const UPDATED = 'November 2026';
const img = (n) => `/guide-img/${n}.webp`;

function Block({ b }) {
  const [t] = b;
  if (t === 'p') return <p>{b[1]}</p>;
  if (t === 'h') return <h3>{b[1]}</h3>;
  if (t === 'steps') return <ol className="g-steps">{b[1].map((x) => <li key={x}>{x}</li>)}</ol>;
  if (t === 'list') return <ul className="g-list">{b[1].map((x) => <li key={x}>{x}</li>)}</ul>;
  if (t === 'tip') return <p className="g-tip"><b>Tip</b> {b[1]}</p>;
  if (t === 'note') return <p className="g-note"><b>Good to know</b> {b[1]}</p>;
  if (t === 'qa') return <div className="g-qa"><h3>{b[1]}</h3><p>{b[2]}</p></div>;
  if (t === 'img') {
    return (
      <figure className={`g-fig ${b[3] || 'shot'}`}>
        <img src={img(b[1])} alt={b[2]} loading="lazy" />
        <figcaption>{b[2]}</figcaption>
      </figure>
    );
  }
  if (t === 'imgrow') {
    return (
      <figure className="g-fig phones">
        <div>{b[1].map((n) => <img key={n} src={img(n)} alt="" loading="lazy" />)}</div>
        <figcaption>{b[2]}</figcaption>
      </figure>
    );
  }
  return null;
}

export default function Guide() {
  useEffect(() => {
    document.title = 'User guide · TrackMyRMA';
    if (location.hash) setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView(), 50);
  }, []);
  const sections = [GUIDE[0], { id: 'why', title: 'Why TrackMyRMA', why: true }, ...GUIDE.slice(1)];
  return (
    <div className="guide">
      <header className="g-head">
        <a href="/" className="legal-brand"><Mark size={34} still /><Wordmark /></a>
        <nav><a href="/">Open the app</a></nav>
      </header>

      <section className="g-cover">
        <Mark size={120} still />
        <h1>TrackMyRMA user guide</h1>
        <p>Set up your company, add masters and care packs, and take every RMA from the customer to the OEM and back — step by step, with pictures.</p>
        <p className="g-ver">{UPDATED} · trackmyrma.com</p>
      </section>

      <div className="g-body">
        <nav className="g-toc" aria-label="Contents">
          <b>Contents</b>
          <ol>{sections.map((s) => <li key={s.id}><a href={`#${s.id}`}>{s.title}</a></li>)}</ol>
        </nav>
        <main id="main" className="g-main">
          {sections.map((s) => (
            <section key={s.id} id={s.id} className="g-sec">
              <h2>{s.title}</h2>
              {s.why ? (
                <>
                  <div className="g-features">
                    {FEATURES.map(([h, t]) => <div key={h}><h3>{h}</h3><p>{t}</p></div>)}
                  </div>
                  <h3>How TrackMyRMA is different</h3>
                  <ul className="g-list">{DIFFERENT.map((x) => <li key={x}>{x}</li>)}</ul>
                </>
              ) : s.blocks.map((b, i) => <Block key={i} b={b} />)}
            </section>
          ))}
          <footer className="g-foot">
            Questions? <a href="mailto:support@trackmyrma.com">support@trackmyrma.com</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
            <br />Pictures show an invented demo company; names, emails and serial numbers are made up.
          </footer>
        </main>
      </div>
    </div>
  );
}

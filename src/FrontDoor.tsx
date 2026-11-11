import { useEffect, useRef, useState } from 'react';
import { ArrowRight, BookmarkSimple, Plus, X } from '@phosphor-icons/react';
import App from './App';
import Brand from './Brand';
import { readBookmarks, writeBookmarks, type Bookmark, type BookmarkLoad } from './bookmarks';
import { normalizeXUrl } from './x-post';
import type { XReference } from './document';

function currentRoute() {
  return location.hash === '#/editor' ? 'editor' : location.hash === '#/bookmarks' ? 'bookmarks' : 'home';
}
export default function FrontDoor() {
  const [route, setRoute] = useState(currentRoute);
  const [editorVisited, setEditorVisited] = useState(route === 'editor');
  const [bookmarkState, setBookmarkState] = useState<BookmarkLoad>(() => {
    try { return readBookmarks(localStorage); } catch { return { items: [], raw: null, blocked: true }; }
  });
  const [bookmarkError, setBookmarkError] = useState('');
  const [removed, setRemoved] = useState<Bookmark[]>([]);
  const [request, setRequest] = useState<{ id: string; reference: XReference } | null>(null);
  const routeHeading = useRef<HTMLHeadingElement>(null);
  const initial = useRef(true);
  useEffect(() => {
    const change = () => { const next = currentRoute(); setRoute(next); if (next === 'editor') setEditorVisited(true); };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    document.title = route === 'home' ? 'Between — Keep the thought. Make it your own.' : `${route === 'editor' ? 'Writing' : 'Bookmarks'} — Between`;
    if (initial.current) { initial.current = false; return; }
    window.scrollTo(0, 0);
    if (route !== 'editor') routeHeading.current?.focus();
  }, [route]);
  function persist(items: Bookmark[]) {
    try { setBookmarkState(writeBookmarks(localStorage, bookmarkState, items)); setBookmarkError(''); return true; }
    catch (error) { setBookmarkError(error instanceof Error ? error.message : 'Bookmarks could not be saved. Your existing bookmarks are unchanged.'); return false; }
  }
  function saveReference(reference: XReference) {
    const existing = bookmarkState.items.find(item => reference.url ? item.reference.url === reference.url && item.reference.text === reference.text : item.reference.text === reference.text);
    if (existing) return 'Already in bookmarks.';
    return persist([{ id: crypto.randomUUID(), savedAt: Date.now(), reference }, ...bookmarkState.items]) ? 'Saved to bookmarks.' : 'Could not save bookmark. Open Bookmarks for details.';
  }
  function openBookmark(bookmark: Bookmark) {
    setRequest({ id: crypto.randomUUID(), reference: bookmark.reference });
    setEditorVisited(true);
    location.hash = '/editor';
  }
  return <>
    {route !== 'editor' && <header className={`site-header ${route === 'bookmarks' ? 'bookmarks-header' : 'home-header'}`}>
      <Brand />
      <nav aria-label="Main navigation">
        <a className="nav-link" href="#/bookmarks" aria-current={route === 'bookmarks' ? 'page' : undefined}>Bookmarks</a>
        <a className="primary-link" href="#/editor" aria-label={route === 'bookmarks' ? 'Write in your workspace' : 'Start writing'}>{route === 'bookmarks' ? 'Write' : 'Start writing'} <ArrowRight size={16} /></a>
      </nav>
    </header>}
    {route === 'home' && <main className="landing">
      <section className="landing-intro">
        <h1 ref={routeHeading} tabIndex={-1}>Keep the thought.<br /><em>Make it your own.</em></h1>
        <p>A writing space for your next X post. Keep the source beside your draft, find what you want to say, and leave with words you stand behind.</p>
        <div className="hero-actions"><a className="primary-link" href="#/editor">Start writing <ArrowRight size={18} /></a><a className="text-link" href="#/bookmarks">Your bookmarks <ArrowRight size={16} /></a></div>
        <span className="hero-note">No account. Drafts saved in this browser.</span>
      </section>
      <figure className="pond-figure">
        <img src="/images/walden-pond.webp" width="1920" height="819" alt="Watercolor of Walden Pond, with still water, woodland, and a small wooden cabin on the shore." fetchPriority="high" />
        <figcaption>A little distance from the feed.</figcaption>
      </figure>
      <section className="landing-detail" aria-labelledby="detail-title">
        <div className="detail-copy"><h2 id="detail-title">Read closely.<br />Respond in your own voice.</h2><p>A post can start a thought without finishing it for you. Between gives the original and your response their own space.</p><p>Save a reference for later. Draft alongside it. If a sentence needs work, ask for an edit right on the page and undo anything that doesn’t fit.</p><a className="text-link" href="#/editor">Make room for your next thought <ArrowRight size={16} /></a></div>
        <div className="writing-example" aria-label="Illustrative writing example"><div><span>Reference</span><p>“A faster answer isn’t always a better one.”</p></div><div><span>Your draft</span><p>The useful pause is the one where you notice what you actually think.</p></div><small>An example of the workspace, not a live post.</small></div>
      </section>
      <section className="landing-control"><h2>Your post. Your final say.</h2><p>Write and save locally. AI assistance uses your OpenAI API key. Edits and automatic prompt detection send draft context and reference text to OpenAI; you can turn auto-detect off. Review your words, then copy them or open X. Between never publishes for you.</p></section>
    </main>}
    <div hidden={route !== 'bookmarks'} inert={route !== 'bookmarks'}>
      <main className="bookmarks-page">
        <div className="bookmarks-heading"><div><h1 ref={route === 'bookmarks' ? routeHeading : undefined} tabIndex={-1}>Thoughts to return to.</h1><p>References you save in Between, on this browser. Nothing is imported from X.</p></div><BookmarkSimple size={32} weight="light" aria-hidden="true" /></div>
        {bookmarkState.blocked && <div className="storage-recovery" role="alert"><p>Saved bookmarks could not be read. Saving is paused and the original data is untouched. Export the original data if available before clearing browser storage.</p>{bookmarkState.raw !== null && <button className="subtle-button" onClick={() => { const url = URL.createObjectURL(new Blob([bookmarkState.raw!], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'between-bookmarks-recovery.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Download original data</button>}</div>}
        {bookmarkError && <p className="source-error" role="alert">{bookmarkError}</p>}
        <div className="bookmark-layout"><BookmarkForm blocked={bookmarkState.blocked} onSave={(reference) => {
          const result = saveReference(reference); return result === 'Saved to bookmarks.' || result === 'Already in bookmarks.';
        }} />
        <section className="bookmark-collection" aria-label="Saved bookmarks">
          <h2>Saved references <span>{bookmarkState.items.length}</span></h2>
          {removed.length > 0 && <div className="bookmark-undo" role="status"><span>Bookmark removed.</span><button onClick={() => { const item = removed[removed.length - 1]; if (persist([item, ...bookmarkState.items])) setRemoved(removed.slice(0, -1)); }}>Undo</button></div>}
          {!bookmarkState.items.length && <div className="bookmark-empty"><BookmarkSimple size={32} weight="light" /><h3>Your next thought starts here.</h3><p>Save a post’s text or link. When you’re ready, open it beside a new draft.</p></div>}
          {bookmarkState.items.map(item => <article className="bookmark-card" key={item.id}><header><h3>{item.reference.authorName || 'Saved reference'}</h3><button className="icon-button" aria-label={`Remove bookmark by ${item.reference.authorName}`} onClick={() => { if (persist(bookmarkState.items.filter(b => b.id !== item.id))) setRemoved([...removed, item]); }}><X size={18} /></button></header>{item.reference.text ? <p className="bookmark-text">{item.reference.text}</p> : <p>Link saved. Open a draft to load the post or paste its text.</p>}<div className="bookmark-card-actions"><button className="secondary-button" onClick={() => openBookmark(item)}>Write a response <ArrowRight size={16} /></button>{item.reference.url && <a className="text-link" href={item.reference.url} target="_blank" rel="noreferrer">Original post ↗</a>}</div></article>)}
        </section></div>
      </main>
    </div>
    {editorVisited && <div hidden={route !== 'editor'} inert={route !== 'editor'}><App visible={route === 'editor'} bookmarkRequest={request} onBookmarkHandled={() => setRequest(null)} onSaveBookmark={saveReference} /></div>}
    {route !== 'editor' && <footer className="site-footer"><span>Between · A writing space, not another feed.</span><a href="#/editor">Open your workspace <ArrowRight size={16} /></a></footer>}
  </>;
}

function BookmarkForm({ blocked, onSave }: { blocked: boolean; onSave: (reference: XReference) => boolean }) {
  const [url, setUrl] = useState(''); const [author, setAuthor] = useState(''); const [text, setText] = useState(''); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  return <form className="bookmark-form" onSubmit={event => {
    event.preventDefault(); setMessage(''); setError('');
    if (!url.trim() && !text.trim()) { setError('Add a post link or its text.'); return; }
    if (text.length > 60_000) { setError('Reference text must be 60,000 characters or fewer. Your text is unchanged.'); return; }
    try { const canonical = url.trim() ? normalizeXUrl(url) : ''; if (onSave({ url: canonical, text: text.trim(), authorName: author.trim() || 'Saved reference', source: 'manual', note: 'Saved by you in Between.' })) { setUrl(''); setText(''); setAuthor(''); setMessage('Saved to bookmarks.'); } }
    catch (e) { setError(e instanceof Error ? e.message : 'Check the post link.'); }
  }}><h2>Save a reference</h2><p>Keep the words that made you stop.</p><label htmlFor="bookmark-url">X post link <span>(optional)</span></label><input id="bookmark-url" type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://x.com/…/status/…" /><label htmlFor="bookmark-author">Author <span>(optional)</span></label><input id="bookmark-author" value={author} onChange={e => setAuthor(e.target.value)} maxLength={200} placeholder="Name or @handle" /><label htmlFor="bookmark-text">Post text <span>(optional with a link)</span></label><textarea id="bookmark-text" rows={7} value={text} onChange={e => setText(e.target.value)} placeholder="Paste the passage you want to keep…" /><p className="form-note">Links are saved as references. To fetch text from X, open a draft and load the post.</p>{error && <p className="source-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}<button className="primary-link" disabled={blocked}><Plus size={18} /> Save bookmark</button></form>;
}

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowSquareOut,
  LinkSimple,
  Quotes,
  X,
  XLogo,
} from "@phosphor-icons/react";
import type { XReference } from "./document";
import { normalizeXUrl } from "./x-post";

type Props = {
  reference?: XReference;
  disabled: boolean;
  onChange: (reference?: XReference) => void;
};
export default function XReferenceSidebar({
  reference,
  disabled,
  onChange,
}: Props) {
  const [url, setUrl] = useState(reference?.url || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [manual, setManual] = useState(false);
  const [manualText, setManualText] = useState(reference?.text || "");
  const [author, setAuthor] = useState(reference?.authorName || "");
  const [pendingReference, setPendingReference] = useState<XReference | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    // Upgrade references saved before full-text lookup was introduced.
    if (reference?.source === "x" && !reference.textStatus) void loadPost();
  }, []);
  useEffect(() => {
    if (!pendingReference || disabled) return;
    onChange(pendingReference);
    setUrl(pendingReference.url);
    setManualText(pendingReference.text);
    setAuthor(pendingReference.authorName);
    setManual(false);
    setPendingReference(null);
  }, [pendingReference, disabled, onChange]);

  async function loadPost() {
    setError("");
    let canonical;
    try {
      canonical = normalizeXUrl(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Paste a valid X post link.");
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    try {
      const response = await fetch("/api/x/reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ url: canonical }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error || "X could not load this post. Paste its text below.",
        );
      if (controller.signal.aborted) return;
      setPendingReference(data);
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(
          e instanceof Error
            ? e.message
            : "Could not load this post. Paste the text instead.",
        );
        setManual(true);
      }
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }

  function saveManual() {
    if (!manualText.trim()) {
      setError("Paste the original post’s text first.");
      return;
    }
    if (manualText.length > 60_000) {
      setError("This reference exceeds 60,000 characters. Nothing has been shortened or saved; reduce the text before using it.");
      return;
    }
    try {
      const canonical = url.trim() ? normalizeXUrl(url) : "";
      onChange({
        url: canonical,
        text: manualText.trim(),
        authorName: author.trim() || "Original post",
        source: "manual",
        note: "Text pasted by you. Open the original to verify the wording.",
      });
      setError("");
      setManual(false);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Check the source link, or leave it blank.",
      );
    }
  }

  return (
    <aside className="x-sidebar" aria-label="Reference post">
      <h2>Reference post</h2>
      <form
        className="source-form"
        onSubmit={(e) => {
          e.preventDefault();
          void loadPost();
        }}
      >
        <label htmlFor="source-url">Link to a post</label>
        <div className="source-url-field">
          <LinkSimple size={16} />
          <input
            id="source-url"
            type="url"
            aria-label="X post link"
            placeholder="https://x.com/…/status/…"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError("");
            }}
            disabled={disabled || loading}
            required
          />
          <button
            type="submit"
            aria-label="Load reference post"
            title="Load reference post"
            disabled={disabled || loading || !url.trim()}
          >
            <ArrowRight size={17} />
          </button>
        </div>
      </form>
      {loading && (
        <div className="source-loading" role="status">
          <span className="intent-dot working" /> Bringing the post into view…
        </div>
      )}
      {pendingReference && disabled && (
        <p className="source-loading" role="status">Reference ready. Finishing the current edit…</p>
      )}
      {error && (
        <p className="source-error" role="alert">
          {error}
        </p>
      )}
      {reference && (
        <article className="reference-card">
          <header>
            <span className="reference-avatar" aria-hidden="true">
              {reference.authorName.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{reference.authorName}</strong>
              <span>
                {reference.authorHandle
                  ? `@${reference.authorHandle}`
                  : reference.source === "manual"
                    ? "Your pasted reference"
                    : "Original author"}
              </span>
            </div>
            <XLogo size={18} />
          </header>
          <blockquote>{reference.text}</blockquote>
          <div className="reference-attribution">
            <span>
              {reference.source === "manual"
                ? "Pasted by you"
                : reference.textStatus === "full_text"
                  ? "Post text from X"
                  : "Excerpt from X"}
            </span>
            {reference.url && (
              <a href={reference.url} target="_blank" rel="noreferrer">
                Open original <ArrowSquareOut size={12} />
              </a>
            )}
          </div>
          <p className="reference-note">
            {reference.note ||
              "Available text only. Open the original for media and full context."}
          </p>
          {reference.textStatus === "possibly_truncated" && (
            <div className="source-incomplete" role="status">
              <strong>X may have shortened this post.</strong>
              <p>Open the original and paste the complete text to keep the whole thought here.</p>
              <button disabled={disabled || loading} onClick={() => {
                setManualText(reference.text);
                setAuthor(reference.authorName);
                setManual(true);
                requestAnimationFrame(() => document.getElementById("source-text")?.focus());
              }}>Paste complete text <ArrowRight size={13} /></button>
            </div>
          )}
          <button
            className="remove-source"
            disabled={disabled || loading}
            onClick={() => {
              abort.current?.abort();
              onChange(undefined);
              setUrl("");
              setManualText("");
              setAuthor("");
              setError("");
            }}
          >
            <X size={12} /> Remove reference
          </button>
        </article>
      )}
      {!reference && !loading && !manual && (
        <div className="source-empty">
          <Quotes size={27} weight="light" />
          <p>Keep the original beside your draft.</p>
        </div>
      )}
      <button
        className="paste-source-toggle"
        aria-expanded={manual}
        disabled={disabled || loading}
        onClick={() => {
          setManual(!manual);
          setManualText(reference?.text || manualText);
          setAuthor(reference?.authorName || author);
        }}
      >
        {manual
          ? "Close text entry"
          : reference
            ? "Edit reference text"
            : "Or paste the post’s text"}
      </button>
      {manual && (
        <div className="manual-source">
          <label htmlFor="source-author">
            Author <span>(optional)</span>
          </label>
          <input
            id="source-author"
            aria-label="Reference author"
            maxLength={200}
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Name or @handle"
            disabled={disabled || loading}
          />
          <label htmlFor="source-text">Original post text</label>
          <textarea
            id="source-text"
            rows={7}
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            placeholder="Paste the words you want to respond to…"
            disabled={disabled || loading}
          />
          {manualText.length > 60_000 && <p className="source-error" role="alert">This text exceeds the 60,000-character reference limit. Your pasted text is intact; shorten it before saving.</p>}
          <button
            className="small-primary"
            onClick={saveManual}
            disabled={disabled || loading || !manualText.trim()}
          >
            Use as reference <ArrowRight size={14} />
          </button>
        </div>
      )}
    </aside>
  );
}

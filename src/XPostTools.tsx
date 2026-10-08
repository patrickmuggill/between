import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowSquareOut,
  Check,
  Copy,
  Eye,
  X,
} from "@phosphor-icons/react";
import { composePost, composerUrl, postLength } from "./x-post";
import { X_PROMPT_GROUPS, type XPrompt } from "./x-prompts";

type Props = {
  draft: string;
  sourceUrl?: string;
  includeSource: boolean;
  onIncludeSource: (value: boolean) => void;
  busy: boolean;
  hasReference: boolean;
  promptExcluded: boolean;
  onPrompt: (prompt: XPrompt) => void;
};
export default function XPostTools({
  draft,
  sourceUrl,
  includeSource,
  onIncludeSource,
  busy,
  hasReference,
  promptExcluded,
  onPrompt,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [group, setGroup] = useState(X_PROMPT_GROUPS[0].id);
  const manualCopy = useRef<HTMLDialogElement>(null);
  const manualText = useRef<HTMLTextAreaElement>(null);
  const text = useMemo(() => composePost(draft, includeSource ? sourceUrl : undefined), [draft, includeSource, sourceUrl]);
  const length = useMemo(() => postLength(text), [text]);
  const selected = X_PROMPT_GROUPS.find((item) => item.id === group)!;
  useEffect(() => {
    setCopied(false);
  }, [text]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2200);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyPost() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      manualCopy.current?.showModal();
      manualText.current?.focus();
      manualText.current?.select();
    }
  }

  return (
    <>
      <section className="post-handoff" aria-label="Prepare your X post">
        <div className="post-options">
          <label>
            <input
              type="checkbox"
              checked={includeSource && Boolean(sourceUrl)}
              onChange={(e) => onIncludeSource(e.target.checked)}
              disabled={busy || !sourceUrl}
            />{" "}
            Include source link
          </label>
          <span
            className={`character-count ${length.remaining < 0 ? "over-limit" : ""}`}
            aria-label={`${length.count} of 280 weighted characters`}
          >
            {length.count}
            <span> / 280</span>
          </span>
        </div>
        {length.remaining < 0 && (
          <p className="length-note">
            {Math.abs(length.remaining)} over the standard post limit. Use “Fit
            one post” or keep a longer draft.
          </p>
        )}
        {promptExcluded && (
          <p className="length-note">
            Your pending instruction is left out of the copied text.
          </p>
        )}
        <div className="post-actions">
          <button
            className="copy-post"
            onClick={() => void copyPost()}
            disabled={busy || !text}
          >
            {copied ? <Check size={17} /> : <Copy size={17} />}{" "}
            {copied ? "Copied" : "Copy post"}
          </button>
          <a
            className={`open-x ${busy || !text || text.length > 6000 ? "disabled" : ""}`}
            aria-disabled={busy || !text || text.length > 6000}
            href={
              busy || !text || text.length > 6000
                ? undefined
                : composerUrl(text)
            }
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              if (busy || !text || text.length > 6000) e.preventDefault();
            }}
          >
            Open in X <ArrowSquareOut size={15} />
          </a>
          <span className="copy-confirmation" role="status">
            {copied ? "Ready to paste into X." : "You choose when to post."}
          </span>
        </div>
        {text.length > 6000 && (
          <p className="length-note">
            For this longer draft, use Copy post and paste it into X.
          </p>
        )}
        {text && (
          <details className="post-preview">
            <summary>
              <Eye size={14} /> Preview copied text
            </summary>
            <p>{text}</p>
            <span>
              Plain text, with your line breaks
              {includeSource && sourceUrl ? " and source link" : ""}.
            </span>
          </details>
        )}
      </section>

      <section className="x-prompt-shelf" aria-label="X copywriting prompts">
        <div className="prompt-shelf-heading">
          <h2>Writing prompts</h2>
        </div>
        <div
          className="prompt-categories"
          role="group"
          aria-label="Prompt category"
        >
          {X_PROMPT_GROUPS.map((item) => (
            <button
              key={item.id}
              aria-pressed={group === item.id}
              onClick={() => setGroup(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="prompt-choices">
          {selected.prompts.map((prompt) => (
            <button
              key={prompt.id}
              className="prompt-choice"
              disabled={
                busy ||
                (prompt.needsDraft
                  ? !draft.trim()
                  : !draft.trim() && !hasReference)
              }
              onClick={() => onPrompt(prompt)}
              title={prompt.instruction}
            >
              <span>
                <strong>{prompt.label}</strong>
                <span>{prompt.description}</span>
              </span>
              <ArrowRight size={15} />
            </button>
          ))}
        </div>
        {!draft.trim() && !hasReference && <p className="prompt-shelf-note">Add a reference or a rough thought to begin.</p>}
      </section>

      <dialog
        ref={manualCopy}
        className="help-dialog copy-dialog"
        aria-labelledby="copy-title"
      >
        <button
          className="icon-button dialog-close"
          aria-label="Close copy dialog"
          onClick={() => manualCopy.current?.close()}
        >
          <X size={20} />
        </button>
        <h2 id="copy-title">Copy your post</h2>
        <p>
          Your browser blocked clipboard access. The text is selected below;
          press <kbd>⌘ / Ctrl C</kbd>, then paste it into X.
        </p>
        <textarea
          ref={manualText}
          aria-label="Post text to copy"
          readOnly
          value={text}
          onFocus={(e) => e.target.select()}
        />
      </dialog>
    </>
  );
}

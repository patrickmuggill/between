import { useState, type RefObject } from "react";
import { X } from "@phosphor-icons/react";

export type ConnectionStatus = "loading" | "ready" | "missing" | "error" | "quota";

export default function ConnectionDialog({ dialogRef, status, onCheck }: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  status: ConnectionStatus;
  onCheck: () => Promise<void>;
}) {
  const [checking, setChecking] = useState(false);
  return (
    <dialog ref={dialogRef} className="help-dialog connection-dialog" aria-labelledby="connection-title"
      onClick={(event) => { if (event.target === dialogRef.current) dialogRef.current?.close(); }}>
      <button className="icon-button dialog-close" aria-label="Close OpenAI settings" onClick={() => dialogRef.current?.close()}><X size={21} /></button>
      <h2 id="connection-title">Connect OpenAI</h2>
      <p>Bring your own API key to enable writing help. Your drafts, references, and copy tools work without one.</p>
      <ol className="setup-steps">
        <li><strong>Get an API key.</strong><span>Create one in <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">OpenAI Platform</a>. API usage is billed separately from ChatGPT.</span></li>
        <li><strong>Save it on this computer.</strong><span>Run this command in the Between folder. The key is hidden as you enter it.</span><pre><code>npm run setup</code></pre></li>
        <li><strong>Restart Between.</strong><span>Then check the connection below. Your key stays on the local server.</span></li>
      </ol>
      <p className="connection-status" role="status">{status === "ready" ? "A key is configured. API access is checked on your first writing request." : status === "quota" ? "Your project needs API credits. Check billing in OpenAI Platform." : status === "error" ? "The local server is unavailable. Start Between and check again." : status === "loading" ? "Checking the local server…" : "No API key is configured yet."}</p>
      <button className="small-primary" disabled={checking} onClick={async () => { setChecking(true); try { await onCheck(); } finally { setChecking(false); } }}>{checking ? "Checking…" : "Check connection"}</button>
      <p className="connection-privacy">Auto-detect sends the paragraph, draft context, and attached reference to OpenAI after a pause. Turn it off to send text only when you ask for help. There are no analytics or automatic posts.</p>
    </dialog>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { closeHistory } from "@tiptap/pm/history";
import { EditorState } from "@tiptap/pm/state";
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  ArrowUp,
  ArrowsInSimple,
  ArrowsOutSimple,
  Check,
  DownloadSimple,
  Feather,
  FileText,
  ListBullets,
  Plus,
  Question,
  Sparkle,
  TextB,
  TextH,
  TextItalic,
  X,
  XLogo,
} from "@phosphor-icons/react";
import {
  currentBlock,
  IntentDecoration,
  intentKey,
  loadDocuments,
  markdown,
  STORAGE_KEY,
  ACTIVE_KEY,
  type Block,
  type DocumentRecord,
} from "./document";
import type { XReference } from "./document";
import XReferenceSidebar from "./XReferenceSidebar";
import XPostTools from "./XPostTools";
import { plainPost } from "./x-post";
import type { XPrompt } from "./x-prompts";
import ConnectionDialog from "./ConnectionDialog";

type Decision = {
  intent: "writing" | "prompting" | "uncertain";
  confidence: number;
  action: "insert" | "rewrite";
  latencyMs: number;
  model: string;
};
type Snapshot = Block & {
  revision: number;
  docId: string;
  mode?: "x";
  reference?: XReference;
  postBudget?: number;
  external?: boolean;
};
function selectedBlockStart(e: Editor) {
  const { $from, $to } = e.state.selection;
  return $from.sameParent($to) && $from.parent.isTextblock && $from.depth >= 1
    ? $from.before()
    : null;
}

function requestExtras(s: Snapshot) {
  return s.mode === "x"
    ? {
        mode: s.mode,
        ...(s.reference
          ? {
              reference: {
                text: s.reference.text,
                authorName: s.reference.authorName,
                url: s.reference.url,
                source: s.reference.source,
              },
            }
          : {}),
        postBudget: s.postBudget,
      }
    : {};
}
type Notice = { text: string; error?: boolean; undo?: boolean } | null;
const examplePrompts = [
  "Make this a little warmer",
  "Turn this into a bullet list",
  "Continue the thought",
];

// Responses in X mode are literal post text, not Markdown. Preserve both
// paragraph breaks and single line breaks without interpreting markup.
function plainTextParagraphs(text: string): JSONContent[] {
  return text.replace(/\r\n?/g, "\n").trim().split("\n\n").map((paragraph) => ({
    type: "paragraph",
    content: paragraph.split("\n").flatMap((line, index) => [
      ...(index ? [{ type: "hardBreak" }] : []),
      ...(line ? [{ type: "text", text: line }] : []),
    ]),
  }));
}

export default function App() {
  const [documents, setDocuments] = useState(loadDocuments);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const [activeId, setActiveId] = useState(() => {
    try {
      const previous = localStorage.getItem(ACTIVE_KEY);
      return documents.some((d) => d.id === previous)
        ? previous!
        : documents[0].id;
    } catch {
      return documents[0].id;
    }
  });
  const [focusMode, setFocusMode] = useState(false);
  const [automatic, setAutomatic] = useState(true);
  const [connection, setConnection] = useState<
    "loading" | "ready" | "missing" | "error" | "quota"
  >("loading");
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const connectionDialog = useRef<HTMLDialogElement>(null);
  const [saved, setSaved] = useState(true);
  const [storageError, setStorageError] = useState(false);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [checking, setChecking] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [preview, setPreview] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [tick, setTick] = useState(0);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [lastLatency, setLastLatency] = useState<number | null>(null);
  const helpRef = useRef<HTMLDialogElement>(null);
  const revision = useRef(0);
  const activeRef = useRef(activeId);
  const lastActiveByMode = useRef<Partial<Record<"document" | "x", string>>>({});
  // Exact, previously identified command paragraphs remain excluded after a
  // selection change or Undo. They are never inferred from wording locally.
  const rememberedPrompts = useRef(new Map<string, Set<string>>());
  const writingOverrides = useRef(new Map<string, Set<string>>());
  const autoRef = useRef(automatic);
  const suppress = useRef(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const detectAbort = useRef<AbortController | null>(null);
  const generateAbort = useRef<AbortController | null>(null);
  const detectorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const decided = useRef<{ snapshot: Snapshot; decision: Decision } | null>(
    null,
  );
  const handlers = useRef({
    update: (_e: Editor) => {},
    select: (_e: Editor) => {},
    key: (_e: KeyboardEvent): boolean => false,
  });

  const editor = useEditor({
    injectCSS: false,
    shouldRerenderOnTransaction: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        link: { openOnClick: false },
        trailingNode: false,
      }),
      Placeholder.configure({
        showOnlyCurrent: false,
        placeholder: "Write a thought, or ask for a little help…",
      }),
      IntentDecoration,
    ],
    content: (documents.find((d) => d.id === activeId) || documents[0]).content,
    editorProps: {
      attributes: {
        class: "writing-surface",
        "aria-label": "Document body",
        role: "textbox",
        "aria-multiline": "true",
        spellcheck: "true",
      },
      handleKeyDown: (_view, event) => handlers.current.key(event),
      handleDOMEvents: {
        compositionend: () => {
          setTimeout(() => {
            if (editorRef.current) handlers.current.update(editorRef.current);
          }, 0);
          return false;
        },
      },
    },
    onUpdate: ({ editor: e }) => handlers.current.update(e),
    onSelectionUpdate: ({ editor: e }) => handlers.current.select(e),
  });
  // Cursor movement only refreshes React when the formatting controls change.
  // The document itself remains owned by ProseMirror.
  useEditorState({
    editor,
    selector: ({ editor: e }) => e ? {
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      heading: e.isActive("heading"),
      bulletList: e.isActive("bulletList"),
      undo: e.can().undo(),
      redo: e.can().redo(),
    } : null,
  });
  const editorRef = useRef(editor);
  editorRef.current = editor;
  activeRef.current = activeId;
  autoRef.current = automatic;
  const active = documents.find((d) => d.id === activeId) || documents[0];
  const xMode = active.mode === "x";
  lastActiveByMode.current[active.mode || "document"] = active.id;
  const editorDocument = editor?.state.doc;
  // ProseMirror document nodes are immutable, so selection and status updates
  // reuse these derived values instead of serializing the whole draft.
  const excludedPrompts = useMemo(
    () => editor && xMode ? promptRanges(editor, active) : [],
    [editor, editorDocument, active.id, active.mode, active.pendingPrompts],
  );
  const draftForCopy = useMemo(
    () => editor && xMode ? plainPost(filteredDraft(editor, active)) : "",
    [editor, editorDocument, active.id, active.mode, active.pendingPrompts],
  );
  const wordCount = useMemo(
    () => editor?.getText().trim().split(/\s+/).filter(Boolean).length || 0,
    [editor, editorDocument],
  );
  void tick;

  function promptRanges(e: Editor, record: DocumentRecord) {
    const known = new Set([
      ...(record.pendingPrompts || []),
      ...(rememberedPrompts.current.get(record.id) || []),
    ]);
    const ranges: Array<{ from: number; to: number; text: string }> = [];
    const overrides = writingOverrides.current.get(record.id);
    if (record.mode !== "x") return ranges;
    e.state.doc.descendants((node, pos) => {
      if (node.isTextblock) {
        const text = node.textContent.trim();
        if (known.has(text) && !overrides?.has(text))
          ranges.push({ from: pos, to: pos + node.nodeSize, text });
        return false;
      }
    });
    return ranges;
  }

  function filteredDraft(e: Editor, record: DocumentRecord, exclude?: Block) {
    const ranges = promptRanges(e, record);
    if (exclude && !ranges.some((range) => range.from === exclude.from))
      ranges.push(exclude);
    const transaction = e.state.tr;
    for (const range of ranges.sort((a, b) => b.from - a.from))
      transaction.delete(range.from, range.to);
    return transaction.doc.toJSON();
  }

  function rememberPrompt(s: Snapshot) {
    if (s.mode !== "x" || s.external) return;
    const text = s.text.trim();
    if (!text || writingOverrides.current.get(s.docId)?.has(text)) return;
    const known = rememberedPrompts.current.get(s.docId) || new Set<string>();
    known.add(text);
    rememberedPrompts.current.set(s.docId, known);
    setDocuments((list) => list.map((record) => record.id === s.docId
      ? { ...record, pendingPrompts: [...new Set([...(record.pendingPrompts || []), text])].slice(-50) }
      : record));
    setSaved(false);
  }

  function treatPromptsAsWriting() {
    if (!editor || busy.current) return;
    const texts = new Set(promptRanges(editor, active).map((range) => range.text));
    const overrides = writingOverrides.current.get(active.id) || new Set<string>();
    for (const text of texts) {
      overrides.add(text);
      rememberedPrompts.current.get(active.id)?.delete(text);
    }
    writingOverrides.current.set(active.id, overrides);
    clearDetection();
    setDocuments((list) => list.map((record) => record.id === active.id
      ? { ...record, pendingPrompts: (record.pendingPrompts || []).filter((text) => !texts.has(text)) }
      : record));
    setSaved(false);
  }

  function clearDetection() {
    if (detectorTimer.current) clearTimeout(detectorTimer.current);
    detectAbort.current?.abort();
    decided.current = null;
    setDecision(null);
    setChecking(false);
    setDetectError(null);
    if (editor && !editor.isDestroyed)
      editor.view.dispatch(editor.state.tr.setMeta(intentKey, null));
  }

  function snapshot(e: Editor): Snapshot | null {
    const block = currentBlock(e);
    const record = documentsRef.current.find((d) => d.id === activeRef.current);
    return block
      ? {
          ...block,
          revision: revision.current,
          docId: activeRef.current,
          ...(record?.mode === "x"
            ? {
                mode: "x" as const,
                context: plainPost(filteredDraft(e, record, block)),
                reference: record.reference,
                postBudget:
                  record.reference?.url && record.includeSource !== false
                    ? 255
                    : 280,
              }
            : {}),
        }
      : null;
  }

  function valid(s: Snapshot) {
    return (
      mounted.current &&
      revision.current === s.revision &&
      activeRef.current === s.docId
    );
  }

  async function classify(s: Snapshot, commit = false) {
    if (["missing", "loading", "error"].includes(connectionRef.current)) return;
    if (s.mode === "x" && writingOverrides.current.get(s.docId)?.has(s.text.trim()))
      return;
    const controller = new AbortController();
    detectAbort.current?.abort();
    detectAbort.current = controller;
    setChecking(true);
    try {
      const response = await fetch("/api/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          text: s.text,
          context: s.context,
          ...requestExtras(s),
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (String(result.error).includes("quota")) setConnection("quota");
        throw new Error(result.error || "Could not check this paragraph.");
      }
      if (
        !valid(s) ||
        controller.signal.aborted ||
        (!commit && selectedBlockStart(editor!) !== s.from)
      )
        return;
      if (result.intent === "prompting") rememberPrompt(s);
      if (commit) {
        setLastLatency(result.latencyMs);
        setConnection("ready");
        if (result.intent === "prompting") void generate(false, s, result);
        return;
      }
      decided.current = { snapshot: s, decision: result };
      setDecision(result);
      setLastLatency(result.latencyMs);
      setDetectError(null);
      setConnection("ready");
      if (result.intent === "prompting")
        editor!.view.dispatch(
          editor!.state.tr.setMeta(intentKey, {
            from: s.from,
            to: s.to,
            className: "is-prompt",
          }),
        );
    } catch (error) {
      if (!controller.signal.aborted && valid(s))
        setDetectError(
          error instanceof Error ? error.message : "Detection unavailable.",
        );
    } finally {
      if (detectAbort.current === controller) setChecking(false);
    }
  }

  function schedule(e: Editor) {
    clearDetection();
    if (
      !autoRef.current || busy.current || e.view.composing ||
      connectionRef.current !== "ready"
    ) return;
    const from = selectedBlockStart(e);
    if (from === null || e.state.selection.$from.parent.textContent.trim().length < 4)
      return;
    const scheduledRevision = revision.current;
    const docId = activeRef.current;
    // Build context after the pause, not on every keystroke in a long draft.
    detectorTimer.current = setTimeout(() => {
      if (
        e.isDestroyed || busy.current || e.view.composing || !autoRef.current ||
        connectionRef.current !== "ready" || revision.current !== scheduledRevision ||
        activeRef.current !== docId || selectedBlockStart(e) !== from
      ) return;
      const s = snapshot(e);
      if (s) void classify(s);
    }, 650);
  }

  handlers.current.update = (e) => {
    revision.current += 1;
    setDocuments((list) =>
      list.map((d) =>
        d.id === activeRef.current
          ? { ...d, content: e.getJSON(), updated: Date.now() }
          : d,
      ),
    );
    setSaved(false);
    if (!suppress.current) schedule(e);
  };
  handlers.current.select = (e) => {
    if (busy.current) return;
    if (decided.current && decided.current.snapshot.from !== selectedBlockStart(e))
      clearDetection();
  };
  handlers.current.key = (event) => {
    if (event.isComposing || editor?.view.composing || event.keyCode === 229)
      return false;
    if (event.key === "Escape" && busy.current) {
      generateAbort.current?.abort();
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      const explicit = event.metaKey || event.ctrlKey;
      const detected = decided.current;
      if (
        explicit ||
        (autoRef.current &&
          detected?.decision.intent === "prompting" &&
          valid(detected.snapshot))
      ) {
        event.preventDefault();
        void generate(explicit);
        return true;
      }
      // Enter stays immediate for prose. If detection has not finished, classify
      // the just-completed paragraph after its native newline, then act only
      // if the user has not typed anything else in the meantime.
      if (
        autoRef.current && connectionRef.current === "ready" &&
        !detected &&
        editor?.state.selection.empty &&
        editor.state.selection.$from.parentOffset ===
          editor.state.selection.$from.parent.content.size
      ) {
        const submitted = snapshot(editor);
        if (submitted && submitted.text.trim().length >= 4)
          setTimeout(() => {
            if (
              !editor.isDestroyed &&
              activeRef.current === submitted.docId &&
              revision.current === submitted.revision + 1 &&
              editor.state.doc.nodeAt(submitted.from)?.textContent ===
                submitted.text
            ) {
              clearDetection();
              void classify({ ...submitted, revision: revision.current }, true);
            }
          }, 0);
      }
    }
    return false;
  };

  async function generate(
    force = false,
    target?: Snapshot,
    knownDecision?: Decision,
  ) {
    if (!editor || busy.current || editor.view.composing) return;
    if (connectionRef.current === "missing" || connectionRef.current === "error") {
      connectionDialog.current?.showModal();
      return;
    }
    const s = target || snapshot(editor);
    if (!s?.text.trim()) return;
    const d = knownDecision
      ? { snapshot: s, decision: knownDecision }
      : decided.current;
    if (
      !force &&
      (!d || !valid(d.snapshot) || d.decision.intent !== "prompting")
    )
      return;
    if (force) writingOverrides.current.get(s.docId)?.delete(s.text.trim());
    rememberPrompt(s);
    busy.current = true;
    setGenerating(true);
    setPreview("");
    setNotice(null);
    clearDetection();
    const controller = new AbortController();
    generateAbort.current = controller;
    editor.setEditable(false, false);
    if (!s.external)
      editor.view.dispatch(
        editor.state.tr.setMeta(intentKey, {
          from: s.from,
          to: s.to,
          className: "is-prompt is-processing",
        }),
      );
    let output = "";
    let completed = false;
    try {
      let action = d?.decision.action;
      if (!action || !valid(d!.snapshot)) {
        const answer = await fetch("/api/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            text: s.text,
            context: s.context,
            ...requestExtras(s),
          }),
        });
        const data = await answer.json();
        if (!answer.ok)
          throw new Error(data.error || "Could not interpret that request.");
        action = data.action;
      }
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          prompt: s.text,
          context: s.context,
          action,
          ...requestExtras(s),
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Could not make that change.");
      }
      if (!response.body) throw new Error("No response received. Try again.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder
          .decode(chunk.value, { stream: true })
          .replace(/\r\n/g, "\n");
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!data) continue;
          const event = JSON.parse(data);
          if (event.type === "delta") {
            output += event.text;
            setPreview(output);
          }
          if (event.type === "error")
            throw new Error(event.error || "The response was interrupted.");
          if (event.type === "done") completed = true;
        }
      }
      if (!completed || !output.trim())
        throw new Error(
          "The response was incomplete. Your writing is unchanged.",
        );
      if (controller.signal.aborted || !valid(s)) return;
      let content: string | JSONContent[];
      if (s.mode === "x") {
        content = [...plainTextParagraphs(output), { type: "paragraph" }];
      } else {
        const { renderGeneratedMarkdown } = await import("./generated-markdown");
        const html = renderGeneratedMarkdown(output.trim());
        if (!html.trim())
          throw new Error("The response was empty. Your writing is unchanged.");
        content = html + "<p></p>";
      }
      // Loading the document-only renderer is asynchronous. Escape may have
      // canceled the request while it was loading, so recheck before applying.
      if (controller.signal.aborted || !valid(s)) return;
      suppress.current = true;
      editor.setEditable(true, false);
      editor.view.dispatch(closeHistory(editor.state.tr));
      const following = editor.state.doc.nodeAt(s.to);
      const insertEnd =
        following?.type.name === "paragraph" && following.content.size === 0
          ? s.to + following.nodeSize
          : s.to;
      editor
        .chain()
        .focus()
        .insertContentAt(
          action === "rewrite" || s.external
            ? { from: 0, to: editor.state.doc.content.size }
            : { from: s.from, to: insertEnd },
          content,
          { updateSelection: true },
        )
        .run();
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.focus();
      suppress.current = false;
      setNotice({
        text:
          action === "rewrite"
            ? "A fresh take. Still your words."
            : "A little help, right where you left off.",
        undo: true,
      });
    } catch (error) {
      if (controller.signal.aborted)
        setNotice({ text: "Stopped. Your writing is unchanged." });
      else
        setNotice({
          text:
            error instanceof Error
              ? error.message
              : "Something went wrong. Your writing is unchanged.",
          error: true,
        });
    } finally {
      suppress.current = false;
      busy.current = false;
      if (!editor.isDestroyed) {
        editor.setEditable(true, false);
        editor.view.dispatch(editor.state.tr.setMeta(intentKey, null));
      }
      if (mounted.current) {
        setGenerating(false);
        setPreview("");
      }
    }
  }

  useEffect(() => {
    mounted.current = true;
    fetch("/api/health")
      .then((r) => r.json())
      .then((data) => setConnection(data.configured ? "ready" : "missing"))
      .catch(() => setConnection("error"));
    return () => {
      mounted.current = false;
      detectAbort.current?.abort();
      generateAbort.current?.abort();
      if (detectorTimer.current) clearTimeout(detectorTimer.current);
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(documents));
        localStorage.setItem(ACTIVE_KEY, activeId);
        setSaved(true);
        setStorageError(false);
      } catch {
        setStorageError(true);
        setSaved(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [documents, activeId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && busy.current)
        generateAbort.current?.abort();
    };
    const flush = () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(documentsRef.current));
        localStorage.setItem(ACTIVE_KEY, activeRef.current);
      } catch {
        /* The save indicator already exposes failures. */
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  function switchDocument(id: string) {
    if (!editor || busy.current) return;
    const doc = documents.find((d) => d.id === id);
    if (!doc) return;
    clearDetection();
    revision.current += 1;
    activeRef.current = id;
    setActiveId(id);
    editor.commands.setContent(doc.content, { emitUpdate: false });
    resetHistory(editor);
    setNotice(null);
  }
  function newDocument(mode: "document" | "x" = active.mode || "document") {
    if (!editor || busy.current) return;
    const doc: DocumentRecord = {
      id: crypto.randomUUID(),
      title: mode === "x" ? "Untitled post" : "Untitled",
      content: { type: "doc", content: [{ type: "paragraph" }] },
      updated: Date.now(),
      mode,
      includeSource: true,
    };
    clearDetection();
    revision.current += 1;
    activeRef.current = doc.id;
    setActiveId(doc.id);
    setDocuments((ds) => [...ds, doc]);
    editor.commands.setContent(doc.content, { emitUpdate: false });
    resetHistory(editor);
    editor.commands.focus("end");
    setNotice(null);
  }
  function chooseMode(mode: "document" | "x") {
    if (busy.current) return;
    if ((active.mode || "document") === mode) return;
    const lastId = lastActiveByMode.current[mode];
    const previous = documents.find((d) => d.id === lastId && (d.mode || "document") === mode)
      || [...documents].reverse().find((d) => (d.mode || "document") === mode);
    if (previous) switchDocument(previous.id);
    else newDocument(mode);
    setFocusMode(false);
  }
  function updateXDocument(patch: Partial<DocumentRecord>) {
    if (busy.current) return;
    clearDetection();
    revision.current += 1;
    setDocuments((ds) =>
      ds.map((d) =>
        d.id === activeRef.current
          ? { ...d, ...patch, updated: Date.now() }
          : d,
      ),
    );
    setSaved(false);
  }
  function runXPrompt(prompt: XPrompt) {
    if (!editor || busy.current) return;
    const context = plainPost(filteredDraft(editor, active));
    const s: Snapshot = {
      from: 0,
      to: editor.state.doc.content.size,
      text: prompt.instruction,
      context,
      docId: activeRef.current,
      revision: revision.current,
      external: true,
      mode: "x",
      reference: active.reference,
      postBudget:
        active.reference?.url && active.includeSource !== false ? 255 : 280,
    };
    void generate(false, s, {
      intent: "prompting",
      action: context ? "rewrite" : "insert",
      confidence: 1,
      latencyMs: 0,
      model: "explicit-writing-prompt",
    });
  }
  function resetHistory(e: Editor) {
    e.view.updateState(
      EditorState.create({
        schema: e.schema,
        doc: e.state.doc,
        plugins: e.state.plugins,
      }),
    );
    setTick((t) => t + 1);
  }
  function addExample(text: string) {
    if (!editor || busy.current) return;
    const last = editor.state.doc.lastChild;
    if (last?.type.name === "paragraph" && !last.textContent)
      editor.chain().focus("end").insertContent(text).run();
    else
      editor
        .chain()
        .focus("end")
        .insertContent([
          { type: "paragraph", content: [{ type: "text", text }] },
        ])
        .run();
  }
  function undo() {
    if (!editor || busy.current) return;
    suppress.current = true;
    clearDetection();
    editor.chain().focus().undo().run();
    suppress.current = false;
    setNotice(null);
  }
  function exportDocument() {
    if (!editor) return;
    const blob = new Blob(
      [`# ${active.title}\n\n${markdown(editor.getJSON())}\n`],
      { type: "text/markdown;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${active.title.replace(/[^a-z0-9 -]/gi, "").slice(0, 80) || "Untitled"}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const label = generating
    ? "Making a little magic"
    : detectError
      ? "Detection unavailable"
      : checking
        ? "Reading the room"
        : decision?.intent === "prompting"
          ? "That sounds like a prompt"
          : decision?.intent === "uncertain"
            ? "Keep going. I’m listening."
            : automatic
              ? "You’re writing"
              : "Just writing";

  return (
    <div
      className={`app ${focusMode ? "is-focused" : ""} ${xMode ? "x-mode" : ""}`}
    >
      <header className="app-header">
        <a className="wordmark" href="/" aria-label="Between home">
          <span className="brand-symbol" aria-hidden="true">
            <i />
            <i />
          </span>
          between
        </a>
        <div className="mode-switch" role="group" aria-label="Writing mode">
          <button
            aria-pressed={!xMode}
            disabled={generating}
            onClick={() => chooseMode("document")}
          >
            <Feather size={14} /> Document
          </button>
          <button
            aria-pressed={xMode}
            disabled={generating}
            onClick={() => chooseMode("x")}
          >
            <XLogo size={13} /> X post
          </button>
        </div>
        <nav className="header-actions" aria-label="Workspace">
          <div className="document-picker">
            <FileText size={16} />
            <select
              aria-label="Choose document"
              value={activeId}
              onChange={(e) => switchDocument(e.target.value)}
              disabled={generating}
            >
              {documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title || "Untitled"}
                </option>
              ))}
            </select>
          </div>
          <button
            className="icon-button"
            aria-label="New document"
            title="New document"
            onClick={() => newDocument()}
            disabled={generating}
          >
            <Plus size={19} />
          </button>
          <span className="header-divider" />
          <button
            className="icon-button"
            aria-label="How it works"
            title="How it works"
            onClick={() => helpRef.current?.showModal()}
          >
            <Question size={20} />
          </button>
          <button
            className="icon-button"
            aria-label={focusMode ? "Exit focus mode" : "Focus mode"}
            title="Focus mode"
            onClick={() => setFocusMode(!focusMode)}
          >
            {focusMode ? (
              <ArrowsInSimple size={19} />
            ) : (
              <ArrowsOutSimple size={19} />
            )}
          </button>
        </nav>
      </header>

      <main className={`workspace ${xMode ? "x-workspace" : ""}`}>
        {xMode && (
          <XReferenceSidebar
            key={activeId}
            reference={active.reference}
            disabled={generating}
            onChange={(reference) => updateXDocument({ reference })}
          />
        )}
        <div className="draft-column">
          <section className="document" aria-label="Writing document">
            <input
              className="document-title"
              aria-label="Document title"
              maxLength={160}
              value={active.title}
              disabled={generating}
              onChange={(e) => {
                const title = e.target.value;
                setDocuments((ds) =>
                  ds.map((d) =>
                    d.id === activeId
                      ? { ...d, title, updated: Date.now() }
                      : d,
                  ),
                );
                setSaved(false);
              }}
              placeholder="Untitled"
            />
            <div className="document-subline">
              <span className="save-state" role="status">{storageError ? "Not saved · export a copy" : saved ? <><Check size={13} /> Saved on this device</> : "Saving…"}</span>
              <button
                className={`auto-toggle ${automatic ? "enabled" : ""}`}
                onClick={() => {
                  if (connection === "missing") { connectionDialog.current?.showModal(); return; }
                  clearDetection();
                  setAutomatic(!automatic);
                }}
                aria-label={connection === "missing" ? "Set up OpenAI" : `Auto-detect ${automatic ? "on" : "off"}`}
                aria-pressed={connection === "missing" ? undefined : automatic}
                disabled={generating}
              >
                <Sparkle size={14} weight={automatic ? "fill" : "regular"} />{" "}
                {connection === "missing" ? "Set up OpenAI" : `Auto-detect ${automatic ? "on" : "off"}`}
                {connection !== "missing" && <span className="toggle-track">
                  <i />
                </span>}
              </button>
            </div>
            <div
              className="toolbar"
              role="toolbar"
              aria-label="Text formatting"
            >
              <div className="format-buttons">
                <button
                  className={`icon-button ${editor?.isActive("bold") ? "selected" : ""}`}
                  title="Bold (⌘B)"
                  aria-label="Bold"
                  aria-pressed={editor?.isActive("bold") || false}
                  onClick={() => editor?.chain().focus().toggleBold().run()}
                  disabled={generating}
                >
                  <TextB size={17} />
                </button>
                <button
                  className={`icon-button ${editor?.isActive("italic") ? "selected" : ""}`}
                  title="Italic (⌘I)"
                  aria-label="Italic"
                  aria-pressed={editor?.isActive("italic") || false}
                  onClick={() => editor?.chain().focus().toggleItalic().run()}
                  disabled={generating}
                >
                  <TextItalic size={17} />
                </button>
                <button
                  className={`icon-button ${editor?.isActive("heading") ? "selected" : ""}`}
                  title="Heading"
                  aria-label="Heading"
                  aria-pressed={editor?.isActive("heading") || false}
                  onClick={() =>
                    editor?.chain().focus().toggleHeading({ level: 2 }).run()
                  }
                  disabled={generating}
                >
                  <TextH size={17} />
                </button>
                <button
                  className={`icon-button ${editor?.isActive("bulletList") ? "selected" : ""}`}
                  title="Bullet list"
                  aria-label="Bullet list"
                  aria-pressed={editor?.isActive("bulletList") || false}
                  onClick={() =>
                    editor?.chain().focus().toggleBulletList().run()
                  }
                  disabled={generating}
                >
                  <ListBullets size={18} />
                </button>
                <span className="toolbar-divider" />
                <button
                  className="icon-button"
                  title="Undo (⌘Z)"
                  aria-label="Undo"
                  onClick={undo}
                  disabled={generating || !editor?.can().undo()}
                >
                  <ArrowCounterClockwise size={16} />
                </button>
                <button
                  className="icon-button"
                  title="Redo (⌘⇧Z)"
                  aria-label="Redo"
                  onClick={() => {
                    suppress.current = true;
                    clearDetection();
                    editor?.chain().focus().redo().run();
                    suppress.current = false;
                  }}
                  disabled={generating || !editor?.can().redo()}
                >
                  <ArrowClockwise size={16} />
                </button>
              </div>
              <button
                className="icon-button export-button"
                title="Export Markdown"
                aria-label="Export Markdown"
                onClick={exportDocument}
              >
                <DownloadSimple size={17} />
              </button>
            </div>

            <EditorContent editor={editor} />
            <div
              className={`intent-row ${decision?.intent === "prompting" ? "prompting" : ""} ${generating ? "generating" : ""}`}
              aria-live="polite"
            >
              <span className="intent-label">
                <span
                  className={`intent-dot ${checking || generating ? "working" : ""}`}
                />
                {label}
              </span>
              {generating ? (
                <button
                  className="subtle-button"
                  onClick={() => generateAbort.current?.abort()}
                >
                  Stop <kbd>esc</kbd>
                </button>
              ) : decision?.intent === "prompting" ? (
                <button className="run-prompt" onClick={() => void generate()}>
                  Make it happen <kbd>↵</kbd>
                  <ArrowUp size={15} />
                </button>
              ) : null}
            </div>
            {generating && (
              <div
                className="generation-preview"
                aria-label="AI response in progress"
              >
                <Sparkle size={16} />
                <p>{preview || "Finding the right words…"}</p>
              </div>
            )}
            {detectError && (
              <div className="detection-error" role="alert">
                {detectError}{" "}
                {detectError.includes("quota") && (
                  <a
                    href="https://platform.openai.com/settings/organization/billing/overview"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open API billing ↗
                  </a>
                )}{" "}
                <button
                  onClick={() => {
                    const s = editor && snapshot(editor);
                    if (s) void classify(s);
                  }}
                >
                  Try again
                </button>
              </div>
            )}
          </section>

          {xMode && excludedPrompts.length > 0 && (
            <div className="detection-error" role="status">
              {excludedPrompts.length === 1
                ? "One identified instruction is excluded from your post."
                : `${excludedPrompts.length} identified instructions are excluded from your post.`}{" "}
              <button onClick={treatPromptsAsWriting} disabled={generating}>
                Treat as writing
              </button>
            </div>
          )}
          {xMode ? (
            <XPostTools
              draft={draftForCopy}
              sourceUrl={active.reference?.url}
              includeSource={active.includeSource !== false}
              onIncludeSource={(includeSource) =>
                updateXDocument({ includeSource })
              }
              busy={generating}
              hasReference={Boolean(active.reference?.text)}
              promptExcluded={excludedPrompts.length > 0}
              onPrompt={runXPrompt}
            />
          ) : (
            <aside className="invitation" aria-label="Try an inline prompt">
              <p>Try a request on the page</p>
              <div className="examples">
                {examplePrompts.map((prompt) => (
                  <button
                    key={prompt}
                    disabled={generating}
                    onClick={() => addExample(prompt)}
                  >
                    {prompt}
                    <span aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
            </aside>
          )}
        </div>
      </main>

      <footer className="app-footer">
        <button className="connection connection-button" aria-label="OpenAI settings" onClick={() => connectionDialog.current?.showModal()}>
          <span
            className={`connection-dot ${connection === "ready" ? "ready" : ""}`}
          />
          {connection === "ready"
            ? "OpenAI configured"
            : connection === "quota"
              ? "API credits needed"
              : connection === "loading"
                ? "Connecting…"
                : connection === "missing"
                  ? "API key needed"
                  : "Server unavailable"}
          {lastLatency !== null && (
            <span className="latency">{lastLatency} ms</span>
          )}
        </button>
        <span>
          {wordCount} {wordCount === 1 ? "word" : "words"}
          <span className="footer-divider" />
          <kbd>⌘</kbd>
          <kbd>↵</kbd> run an inline request
        </span>
      </footer>

      {notice && (
        <div
          className={`toast ${notice.error ? "error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          <span>
            {notice.error ? null : <Check size={16} />} {notice.text}
          </span>
          {notice.undo && <button onClick={undo}>Undo</button>}
          <button
            className="toast-close"
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}

      <dialog
        ref={helpRef}
        className="help-dialog"
        aria-labelledby="help-title"
        onClick={(e) => {
          if (e.target === helpRef.current) helpRef.current.close();
        }}
      >
        <button
          className="icon-button dialog-close"
          aria-label="Close help"
          onClick={() => helpRef.current?.close()}
        >
          <X size={21} />
        </button>
        <h2 id="help-title">Writing with Between</h2>
        <p>
          Just start writing. When a paragraph sounds like a request, it turns
          green. Press <kbd>Enter</kbd> and watch it become part of your draft.
        </p>
        <ol>
          <li>
            <strong>Write naturally.</strong>
            <span>Prose stays prose. There’s no mode to switch.</span>
          </li>
          <li>
            <strong>Ask on the page.</strong>
            <span>
              Try “fix the grammar above” or “make the word ideas bold.”
            </span>
          </li>
          <li>
            <strong>Keep what works.</strong>
            <span>
              Every AI edit has Undo. <kbd>Shift ↵</kbd> keeps a line break;{" "}
              <kbd>⌘ ↵</kbd> explicitly runs a request.
            </span>
          </li>
        </ol>
        <div className="privacy-note">
          <strong>Privacy</strong>
          <p>
            Your drafts save in this browser. With auto-detect on, the paragraph
            and document context go to OpenAI after a short pause. Turn it off
            to write without automatic API calls. Your key stays on the local
            server.
          </p>
          <p>
            The connection indicator shows key configuration. Actual API access
            is checked when you type.
          </p>
        </div>
        <a
          href="https://developers.openai.com/api/docs/guides/decisions"
          target="_blank"
          rel="noreferrer"
        >
          Built with the OpenAI Decisions API ↗
        </a>
      </dialog>
      <ConnectionDialog dialogRef={connectionDialog} status={connection} onCheck={async () => {
        try { const response = await fetch("/api/health"); if (!response.ok) throw new Error(); const data = await response.json(); setConnection(data.configured ? "ready" : "missing"); }
        catch { setConnection("error"); }
      }} />
    </div>
  );
}

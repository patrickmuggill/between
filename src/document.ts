import type { JSONContent, Editor } from "@tiptap/react";
import { Extension, getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { normalizeXUrl } from "./x-post.ts";

export type DocumentRecord = {
  id: string;
  title: string;
  content: JSONContent;
  updated: number;
  mode?: "document" | "x";
  reference?: XReference;
  includeSource?: boolean;
  pendingPrompts?: string[];
};
export type XReference = {
  url: string;
  postId?: string;
  authorName: string;
  authorHandle?: string;
  text: string;
  source: "x" | "manual";
  fetchedAt?: string;
  note?: string;
  textStatus?: "full_text" | "possibly_truncated" | "unverified";
};
export const STORAGE_KEY = "between.documents.v1";
export const ACTIVE_KEY = "between.active.v1";
const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : undefined,
});
export const welcome: DocumentRecord = {
  id: "first-page",
  title: "Untitled post",
  updated: Date.now(),
  mode: "x",
  includeSource: true,
  content: {
    type: "doc",
    content: [paragraph("")],
  },
};
export type DocumentLoad = {
  documents: DocumentRecord[];
  recovery: { raw: string | null; backupKey: string | null } | null;
  writeBlocked: boolean;
};
type DraftStorage = Pick<Storage, "getItem" | "setItem">;

/** Preserve exact original bytes before permitting recovery to overwrite storage.
 * Reuse identical backups (including React Strict Mode initialization), but never
 * replace a different backup. Failure leaves the canonical collection untouched.
 */
function preserveOriginal(storage: DraftStorage, raw: string): string {
  for (let suffix = 0; ; suffix += 1) {
    const key = `${STORAGE_KEY}.recovery${suffix ? `.${suffix}` : ""}`;
    const existing = storage.getItem(key);
    if (existing === raw) return key;
    if (existing !== null) continue;
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw new Error("Recovery backup was not saved.");
    return key;
  }
}

export function loadDocumentState(storage?: DraftStorage): DocumentLoad {
  let raw: string | null;
  try { storage ??= localStorage; raw = storage.getItem(STORAGE_KEY); }
  catch { return { documents: [welcome], recovery: { raw: null, backupKey: null }, writeBlocked: true }; }
  if (raw === null) return { documents: [welcome], recovery: null, writeBlocked: false };
  let damaged = false;
  let documents: DocumentRecord[] = [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error("Invalid draft collection.");
    const schema = getSchema([StarterKit]);
    const ids = new Set<string>();
    for (const doc of data) {
      try {
        if (!doc || typeof doc.id !== "string" || typeof doc.title !== "string" ||
          doc.content?.type !== "doc" || !Array.isArray(doc.content.content) || ids.has(doc.id))
          throw new Error("Invalid draft.");
        schema.nodeFromJSON(doc.content).check();
        ids.add(doc.id);
        let reference: XReference | undefined;
        const value = doc.reference;
        if (value && typeof value.text === "string" && value.text.trim() && value.text.length <= 60_000 &&
          typeof value.authorName === "string" && value.authorName.length <= 200 &&
          ["x", "manual"].includes(value.source) && typeof value.url === "string") {
          try {
            const url = value.url ? normalizeXUrl(value.url) : "";
            reference = {
              url, text: value.text, authorName: value.authorName, source: value.source,
              ...(typeof value.authorHandle === "string" ? { authorHandle: value.authorHandle } : {}),
              ...(typeof value.note === "string" ? { note: value.note } : {}),
              ...(["full_text", "possibly_truncated", "unverified"].includes(value.textStatus) ? { textStatus: value.textStatus } : {}),
            };
          } catch { /* A malformed source must not make the draft inaccessible. */ }
        }
        if (value && !reference) damaged = true;
        documents.push({
          ...doc,
          mode: doc.mode === "x" ? "x" : "document",
          reference,
          includeSource: doc.includeSource !== false,
          pendingPrompts: Array.isArray(doc.pendingPrompts)
            ? doc.pendingPrompts.filter((text: unknown) => typeof text === "string" && text.length <= 6000).slice(-100)
            : [],
        });
      } catch { damaged = true; }
    }
  } catch { damaged = true; }
  if (!documents.length) documents = [welcome];
  if (!damaged) return { documents, recovery: null, writeBlocked: false };
  try {
    const backupKey = preserveOriginal(storage, raw);
    return { documents, recovery: { raw, backupKey }, writeBlocked: false };
  } catch {
    return { documents, recovery: { raw, backupKey: null }, writeBlocked: true };
  }
}

export function saveDocuments(storage: DraftStorage, load: DocumentLoad, documents: DocumentRecord[], activeId: string) {
  if (load.writeBlocked) throw new Error("Original drafts must be preserved before saving.");
  storage.setItem(STORAGE_KEY, JSON.stringify(documents));
  storage.setItem(ACTIVE_KEY, activeId);
}
export function markdown(node: JSONContent): string {
  if (node.type === "text") {
    let text = (node.text || "").replace(/([\\`*_\[\]<>])/g, "\\$1");
    for (const mark of node.marks || []) {
      if (mark.type === "bold") text = `**${text}**`;
      if (mark.type === "italic") text = `*${text}*`;
      if (mark.type === "strike") text = `~~${text}~~`;
      if (mark.type === "code") text = "`" + (node.text || "") + "`";
      if (mark.type === "link" && /^https?:\/\//i.test(mark.attrs?.href || ""))
        text = `[${text}](${String(mark.attrs?.href).replace(/[()\s]/g, (c) => encodeURIComponent(c))})`;
    }
    return text;
  }
  if (node.type === "hardBreak") return "\n";
  const parts = (node.content || []).map(markdown);
  if (node.type === "doc") return parts.join("\n\n");
  if (node.type === "heading")
    return "#".repeat(node.attrs?.level || 2) + " " + parts.join("");
  if (node.type === "bulletList")
    return parts.map((s) => "- " + s.replace(/\n/g, "\n  ")).join("\n");
  if (node.type === "orderedList")
    return parts
      .map((s, i) => `${i + 1}. ` + s.replace(/\n/g, "\n   "))
      .join("\n");
  if (node.type === "listItem") return parts.join("\n");
  if (node.type === "blockquote")
    return parts
      .join("\n")
      .split("\n")
      .map((s) => "> " + s)
      .join("\n");
  if (node.type === "codeBlock") return "```\n" + parts.join("") + "\n```";
  return parts.join("");
}

export type Block = { from: number; to: number; text: string; context: string };
export function currentBlock(editor: Editor): Block | null {
  const { $from, $to } = editor.state.selection;
  if (!$from.sameParent($to) || !$from.parent.isTextblock || $from.depth < 1)
    return null;
  const from = $from.before(),
    to = $from.after();
  const withoutPrompt = editor.state.tr.delete(from, to).doc.toJSON();
  return {
    from,
    to,
    text: $from.parent.textContent,
    context: markdown(withoutPrompt),
  };
}

export const intentKey = new PluginKey("between-intent");
export const IntentDecoration = Extension.create({
  name: "intentDecoration",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: intentKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(intentKey);
            if (meta === null) return DecorationSet.empty;
            if (meta) {
              if (meta.to > tr.doc.content.size) return DecorationSet.empty;
              return DecorationSet.create(tr.doc, [
                Decoration.node(meta.from, meta.to, { class: meta.className }),
              ]);
            }
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});

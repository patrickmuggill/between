import { marked } from "marked";
import DOMPurify from "dompurify";

// Loaded on demand for document-mode generation. X posts remain literal text.
export function renderGeneratedMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
    ALLOWED_TAGS: [
      "p", "strong", "b", "em", "i", "s", "del", "ul", "ol", "li",
      "h2", "h3", "blockquote", "br", "code", "pre", "a",
    ],
    ALLOWED_ATTR: ["href"],
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
  });
}

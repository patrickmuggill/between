import type { JSONContent } from "@tiptap/react";
// Import the official counter and URL extractor without its unrelated linkifier.
import parseTweet from "twitter-text/dist/parseTweet.js";
import extractUrls from "twitter-text/dist/extractUrls.js";

export function normalizeXUrl(value: string): string {
  const url = new URL(value.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    ![
      "x.com",
      "www.x.com",
      "twitter.com",
      "www.twitter.com",
      "mobile.twitter.com",
      "mobile.x.com",
    ].includes(url.hostname.toLowerCase())
  )
    throw new Error(
      "Use a link to an X or Twitter post, like https://x.com/name/status/123.",
    );
  const match =
    url.pathname.match(
      /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:\/(?:photo|video)\/\d+)?\/?$/,
    ) || url.pathname.match(/^\/i\/(?:web\/)?status\/(\d{1,25})\/?$/);
  if (!match)
    throw new Error(
      "That looks like a profile or another page. Paste a link to an individual post.",
    );
  return match.length > 2
    ? `https://x.com/${match[1]}/status/${match[2]}`
    : `https://x.com/i/web/status/${match[1]}`;
}

// X takes plain text. Retain list structure and link destinations, without
// leaking Markdown emphasis markers into the text a user copies.
export function plainPost(node: JSONContent): string {
  if (node.type === "text") {
    const text = node.text || "";
    const link = node.marks?.find((mark) => mark.type === "link")?.attrs?.href;
    return link && /^https?:\/\//i.test(link) && link !== text
      ? `${text} (${link})`
      : text;
  }
  if (node.type === "hardBreak") return "\n";
  const parts = (node.content || []).map(plainPost);
  if (node.type === "doc") return parts.join("\n\n").trim();
  if (node.type === "bulletList")
    return parts.map((text) => `• ${text}`).join("\n");
  if (node.type === "orderedList")
    return parts
      .map((text, index) => `${index + (node.attrs?.start || 1)}. ${text}`)
      .join("\n");
  if (node.type === "listItem" || node.type === "blockquote")
    return parts.join("\n");
  return parts.join("");
}

export function composePost(text: string, sourceUrl?: string): string {
  const draft = text.trim();
  if (!draft) return "";
  if (!sourceUrl) return draft;
  const canonical = normalizeXUrl(sourceUrl);
  const alreadyIncluded = extractUrls(draft).some((url) => {
    try {
      return normalizeXUrl(url) === canonical;
    } catch {
      return false;
    }
  });
  return alreadyIncluded ? draft : `${draft}\n\n${canonical}`;
}

export function postLength(text: string) {
  const result = parseTweet(text);
  return {
    count: result.weightedLength,
    remaining: 280 - result.weightedLength,
    valid: result.valid,
  };
}

export function composerUrl(text: string) {
  return `https://x.com/intent/tweet?${new URLSearchParams({ text })}`;
}

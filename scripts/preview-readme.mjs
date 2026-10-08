#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { marked } from "marked";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const previewPort = Number(process.env.README_PORT || 4175);
const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const renderer = new marked.Renderer();
renderer.heading = function({ tokens, depth }) {
  const label = this.parser.parseInline(tokens);
  const slug = label.replace(/<[^>]+>/g, "").toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
  return '<h' + depth + ' id="' + slug + '">' + label + '</h' + depth + '>\n';
};
const documents = new Set(["README.md", "SECURITY.md", "CONTRIBUTING.md", "THIRD_PARTY_NOTICES.md"]);
const mime = { ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" };
const server = createServer(async (req, res) => {
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "HEAD"].includes(req.method) || !["127.0.0.1:" + previewPort, "localhost:" + previewPort].includes(req.headers.host)) { res.writeHead(403).end("Local preview only."); return; }
  try {
    const pathname = new URL(req.url, "http://127.0.0.1:" + previewPort).pathname;
    if (pathname === "/preview.css") {
      res.setHeader("Content-Type", "text/css; charset=utf-8");
      res.end(await readFile(path.join(root, "docs", "readme-preview.css"))); return;
    }
    if (/^\/docs\/assets\/[a-z0-9-]+\.(?:svg|png|webp)$/.test(pathname)) {
      res.setHeader("Content-Type", mime[path.extname(pathname)]);
      res.end(await readFile(path.join(root, pathname.slice(1)))); return;
    }
    if (pathname === "/LICENSE" || pathname === "/.env.example") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(await readFile(path.join(root, pathname.slice(1)))); return;
    }
    const file = pathname === "/" ? "README.md" : pathname.slice(1);
    if (!documents.has(file)) { res.writeHead(404).end("Not found."); return; }
    const contents = await readFile(path.join(root, file), "utf8");
    const body = marked.parse(contents, { renderer, gfm: true });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Between · README preview</title><link rel="stylesheet" href="/preview.css"></head><body><header class="repo-header"><a href="/">patrickmuggill / <strong>between</strong></a><span>Local preview · unpublished</span></header><main><div class="file-header">' + escape(file) + '</div><article class="markdown-body">' + body + '</article></main></body></html>');
  } catch { res.writeHead(404).end("Preview file not found."); }
});
server.listen(previewPort, "127.0.0.1", () => console.log("README preview: http://127.0.0.1:" + previewPort));
server.on("error", error => { console.error(error.code === "EADDRINUSE" ? "README preview port is in use. Set README_PORT to another local port." : "Could not start the local README preview."); process.exitCode = 1; });

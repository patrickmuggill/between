# Security

Between is a single-user application that runs on your own computer. Its trust boundary is the local Node server and the browser profile you use with it. It is not an authenticated hosting platform.

## Protections

- The server binds to `127.0.0.1`. Host, Origin, and fetch-metadata checks apply to the UI, API routes, development files, and development WebSocket. Other websites and sibling local origins cannot use it as an API proxy. CORS is not enabled.
- Content Security Policy restricts script execution and network destinations. Production blocks inline scripts and eval; development uses fresh nonces for Vite. Frame embedding is disabled, MIME sniffing is blocked, and referrer information is limited.
- Development routes use an allowlist; configuration, secrets, Git files, tests, server source, and unrelated workspace files are not served. Production serves only the built app. Hashed assets can be cached; API responses are not cached by the browser.
- OpenAI requests have input, output, byte, concurrency, rate, and time limits. Redirects are rejected, browser disconnects cancel upstream work, and incomplete streams never replace a draft. Error responses do not expose upstream bodies or credentials.
- X lookup uses approved public endpoints, rejects redirects, and sends no browser cookies. HTML is parsed as text; serialized page data is parsed as syntax and never executed. Full-text fallback requires the requested post ID and author. Remote content has byte and time limits.
- Document-mode generated Markdown is sanitized before insertion. X-mode output is literal text. Reference content stays separate from the author’s draft and model instructions.
- `npm run setup` hides key input and writes an ignored local configuration file atomically. It uses restricted POSIX permissions where supported and refuses symlinks. Existing files require explicit overwrite confirmation. No browser API-key field exists.
- Automated tests use synthetic credentials and intercepted or injected network responses. The browser runner skips local credential loading and refuses unexpected live API requests.

These controls have automated tests. They are not an independent security audit or a guarantee against every attack.

## Boundaries

- Do not expose Between through a public tunnel, change its bind address, or put it behind a reverse proxy without designing authentication and isolation first.
- Browser local storage and `.env.local` are not encrypted by Between. Other users with access to your computer, malicious extensions, or compromised dependencies may be able to read them. Use your operating system’s normal account and disk protections.
- Text sent for AI assistance is processed by OpenAI under its [API data policies](https://developers.openai.com/api/docs/guides/your-data). `store: false` disables Responses application-state storage, not all provider retention.
- API spend is charged to your account. Local rate limits reduce accidental bursts; they are not a billing cap. Use project limits in OpenAI Platform as appropriate.
- Prompt-injection instructions help keep source text separate, but model output still needs human review. Between cannot post to X on your behalf; its composer link leaves publication to you.
- X’s public page format can change. When full text cannot be verified, the app retains a labeled excerpt and offers manual text entry.

## Reporting a vulnerability

Use [GitHub’s private vulnerability reporting](https://github.com/patrickmuggill/between/security/advisories/new). If that option is unavailable, contact the [maintainer](https://github.com/patrickmuggill) to arrange a private report. Do not include API keys, private drafts, or exploitable details in a public issue.

Include the affected version or commit, reproduction steps, expected impact, and a minimal example using synthetic data.

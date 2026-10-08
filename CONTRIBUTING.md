# Contributing to Between

Thanks for helping make a small writing tool feel good to use.

## Run it locally

Use Node.js 24. If you use nvm, run `nvm use` in the project directory.

```sh
npm ci
npm run setup
npm run dev
```

`npm run setup` accepts your OpenAI key through a hidden terminal prompt. It writes an ignored `.env.local` file and leaves existing configuration alone unless you explicitly choose to update its key. You can also copy `.env.example` to `.env.local` and edit it privately, or provide `OPENAI_API_KEY` in your environment. An environment variable takes precedence over either dotenv file. Never place a key in a `VITE_` variable: those can be shipped to the browser.

Writing, reference entry, copying, and export work without an OpenAI key. AI detection and drafting use your OpenAI account and require API access and credit. The app is a local, single-user utility; do not expose the server to the public internet.

## Before opening a pull request

```sh
npm run check:release
npm test
npm run build
npx --no-install playwright install chromium
npm run test:browser
```

On Linux, Chromium may need system packages: use `npx --no-install playwright install --with-deps chromium` when setting up a development machine or CI runner.

The browser runner starts a separate production server on an available loopback port. It ignores local dotenv files, clears the OpenAI key, blocks server-side network requests, and intercepts API calls with synthetic fixtures. Every suite uses a fresh browser context. It does not need API credit, use real posts, or change the drafts in your regular browser. Screenshots go in ignored `output/playwright/`.

The unit and integration tests exercise the server's input validation, output handling, security boundaries, copying rules, and setup behavior. Test fixtures must remain synthetic. Do not add private writing, access tokens, real keys, or copied personal browser profiles.

## What makes a useful change

- Keep writing responsive. Typing and copying should work even when a provider is unavailable.
- Preserve the writer's words. Show AI errors and incomplete sources honestly, and keep edits reversible.
- Treat reference posts as quoted context, never as instructions or the writer's opinion.
- Keep full source text visible. Avoid line clamps or hidden overflow in the reference sidebar.
- Preserve keyboard access, visible focus, contrast, and reduced-motion behavior.
- Explain the problem and the changed behavior in your pull request. Include how you checked it, plus screenshots for visible changes.

Small, focused pull requests are easiest to review. Open an issue before a large change to the editor model, data storage, provider boundary, or publishing behavior. If you find a security issue, follow [SECURITY.md](SECURITY.md) rather than posting credentials or exploit details in a public issue.

## Project map

| Location | Purpose |
| --- | --- |
| `src/` | Editor, document storage, X reference sidebar, and copywriting tools |
| `server/` | OpenAI requests, public X reference fetching, and HTTP security |
| `server.mjs` | Local server entry point |
| `scripts/setup.mjs` | Private, interactive key setup |
| `tests/` | Node unit and integration tests |
| `scripts/*check*` | Release checks and isolated browser verification |

Contributions are provided under the repository's [MIT license](LICENSE).

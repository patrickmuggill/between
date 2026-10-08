// Loaded only by the browser-check runner, in a child with dotenv disabled.
// Unexpected unmocked API requests must never reach an external provider.
process.env.BETWEEN_SKIP_DOTENV = "1";
process.env.OPENAI_API_KEY = "";
process.env.NODE_ENV = "production";
const noNetwork = async () => { throw new Error("Live network calls are disabled in browser fixtures."); };
const { startServer } = await import("../server.mjs");
await startServer({ production: true, port: 0,
  apiOptions: { apiKey: "", fetchImpl: noNetwork },
  xOptions: { fetchImpl: noNetwork },
});

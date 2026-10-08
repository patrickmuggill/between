// Cross-platform equivalent of NODE_ENV=production node server.mjs.
process.env.NODE_ENV = "production";
const { startServer } = await import("../server.mjs");
try {
  await startServer({ production: true });
} catch (error) {
  console.error(error.code === "EADDRINUSE"
    ? "That local port is already in use. Close the other app or set a different PORT."
    : error.message);
  process.exitCode = 1;
}

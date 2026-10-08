import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createApp } from "./server/app.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

export async function startServer({ port, production = process.env.NODE_ENV === 'production', ...options } = {}) {
  if (process.env.BETWEEN_SKIP_DOTENV !== '1') dotenv.config({ path: [path.join(root, '.env.local'), path.join(root, '.env')], quiet: true });
  const listenPort = port ?? Number(process.env.PORT || 4173);
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65_535) throw new Error('PORT must be a whole number from 0 to 65535.');
  const instance = await createApp({ root, production, ...options });
  try {
    await new Promise((resolve, reject) => {
      instance.server.once('error', reject);
      instance.server.listen(listenPort, '127.0.0.1', () => { instance.server.off('error', reject); resolve(); });
    });
  } catch (error) { await instance.close(); throw error; }
  console.log(`Between is ready at http://127.0.0.1:${instance.server.address().port}`);
  const shutdown = () => { void instance.close().finally(() => process.exit(0)); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const close = instance.close;
  instance.close = async () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await close();
  };
  return instance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await startServer(); } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? 'That local port is already in use. Close the other app or set a different PORT.' : error.message);
    process.exitCode = 1;
  }
}

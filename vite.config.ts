import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  // Configuration belongs to the local server; no environment values are
  // automatically made available in browser JavaScript.
  envPrefix: [],
  server: { host: "127.0.0.1", allowedHosts: ["localhost"] },
  build: {
    rolldownOptions: {
      output: {
        // Keep the editor/runtime cacheable across changes to our own UI.
        // This does not defer the editor or add a loading state while typing.
        codeSplitting: {
          groups: [
            {
              name: "editor",
              test: /node_modules[\\/](?:@tiptap[\\/]|prosemirror-|orderedmap[\\/]|rope-sequence[\\/]|w3c-keyname[\\/]|crelt[\\/]|linkifyjs[\\/])/,
            },
            {
              name: "react",
              test: /node_modules[\\/](?:react|react-dom|scheduler|use-sync-external-store)[\\/]/,
            },
          ],
        },
      },
    },
  },
});

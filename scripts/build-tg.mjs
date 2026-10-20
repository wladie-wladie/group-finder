// Bundles GramJS (Telegram client API) for the app's WebView into www/js/gram.js.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const shim = n => join(root, "scripts/shims", n);
const tg = n => join(root, "node_modules/telegram", n);

const alias = {
  // GramJS's own Node-only modules → browser versions
  [tg("CryptoFile.js")]: shim("cryptofile.js"),
  [tg("inspect.js")]: shim("inspect.js"),
  [tg("extensions/net.js")]: shim("empty.js"),
  [tg("client/fs.js")]: shim("empty.js"),
};
const builtins = {
  events: require.resolve("events/"),
  util: require.resolve("util/"),
  path: require.resolve("path-browserify"),
  buffer: require.resolve("buffer/"),
  process: require.resolve("process/browser.js"),
  os: shim("os.js"),
  websocket: shim("websocket.js"),
};
const empty = new Set(["fs", "net", "tls", "crypto", "assert", "stream", "constants", "child_process", "dns", "http", "https", "zlib", "socks", "node-localstorage", "graceful-fs", "write-file-atomic", "bufferutil", "utf-8-validate"]);

const plugin = {
  name: "browser-shims",
  setup(b) {
    b.onResolve({ filter: /.*/ }, async args => {
      const p = args.path;
      if (builtins[p]) return { path: builtins[p] };
      if (empty.has(p) || empty.has(p.split("/")[0])) return { path: shim("empty.js") };
      if (p.startsWith(".") && args.resolveDir) {
        let full;
        try { full = require.resolve(join(args.resolveDir, p)); } catch (_) { return; }
        if (alias[full]) return { path: alias[full] };
      }
    });
  },
};

await build({
  entryPoints: [join(root, "src/tg-entry.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
  inject: [shim("globals.js")],
  define: { "process.env.NODE_DEBUG": "false" },
  outfile: join(root, "www/js/gram.js"),
  plugins: [plugin],
  logLevel: "warning",
});
console.log("Built www/js/gram.js");

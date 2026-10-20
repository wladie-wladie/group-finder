// Builds the app UI into www/, which goes inside the APK and into the update bundle.
import { cpSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "www");
const version = process.env.APP_VERSION || "0.0.0";

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "web"), out, { recursive: true });
cpSync(join(root, "node_modules/@capacitor/core/dist/capacitor.js"), join(out, "js/capacitor.js"));
writeFileSync(join(out, "js/version.js"), `export const APP_VERSION = ${JSON.stringify(version)};\n`);
console.log("Built www/ version " + version);

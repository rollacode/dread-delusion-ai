// Builds a plugin from TypeScript: both halves in one pass.
//
//   node scripts/build-plugin.mjs <id>
//
// Logic: esbuild <id>/src/plugin.ts → <id>/plugin.js, a CJS module the QuickJS
// loader accepts (it wraps the source in an IIFE exposing `module`/`exports`,
// runs it, then reads `module.exports.default`). Author source ends with
// `export default plugin`; CJS output assigns it to `module.exports.default`.
// QuickJS has no console/fetch/timers — the @codeterm/plugin-sdk is type-only
// so nothing of the sort is pulled in.
//
// UI (if <id>/ui/src/main.tsx exists): a SPLIT, cacheable bundle —
// ui/app-<hash>.js (content-hashed) + a tiny ui/index.html that loads it via an
// external <script>. Stale app-*.js are removed. The __CT_NONCE__ placeholders
// the view route swaps per-load are preserved.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const id = process.argv[2];
if (!id) {
  console.error("usage: node scripts/build-plugin.mjs <id>");
  process.exit(1);
}

const shortHash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

async function buildLogic() {
  const entry = resolve(repo, `${id}/src/plugin.ts`);
  if (!existsSync(entry)) {
    console.error(`no logic entry: ${entry}`);
    process.exit(1);
  }
  const out = resolve(repo, `${id}/plugin.js`);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    // CJS so the loader's `module.exports.default` read works; neutral platform
    // and es2020 keep it QuickJS-safe (no node/browser globals, no console).
    format: "cjs",
    platform: "neutral",
    target: "es2020",
    write: false,
    logLevel: "warning",
  });
  const js = result.outputFiles.map((f) => f.text).join("");
  writeFileSync(out, js);
  console.log(`built ${id} logic → ${id}/plugin.js (${(js.length / 1024).toFixed(1)} KB)`);
}

async function buildUi() {
  const entry = resolve(repo, `${id}/ui/src/main.tsx`);
  if (!existsSync(entry)) return;
  const uiDir = resolve(repo, `${id}/ui`);

  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    jsx: "automatic",
    minify: true,
    write: false,
    outdir: uiDir,
    loader: { ".svg": "text", ".css": "css" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });

  let js = "";
  let css = "";
  for (const f of result.outputFiles) {
    if (f.path.endsWith(".css")) css += f.text;
    else js += f.text;
  }

  const hash = shortHash(js);
  const jsName = `app-${hash}.js`;

  // Drop stale app-*.js so the dir holds exactly one hashed bundle.
  for (const f of readdirSync(uiDir)) {
    if (/^app-[0-9a-f]+\.js$/.test(f) && f !== jsName) {
      unlinkSync(resolve(uiDir, f));
    }
  }

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style nonce="__CT_NONCE__">html,body{margin:0;background:var(--ct-bg,#14141c);color:var(--ct-fg,#e8e8ef)}${css}</style>
</head>
<body>
<div id="ct-root"></div>
<script nonce="__CT_NONCE__" src="./${jsName}"></script>
</body>
</html>`;

  mkdirSync(uiDir, { recursive: true });
  writeFileSync(resolve(uiDir, jsName), js);
  writeFileSync(resolve(uiDir, "index.html"), html);
  console.log(
    `built ${id} ui → ${id}/ui/{${jsName} (${(js.length / 1024).toFixed(1)} KB), index.html (${(html.length / 1024).toFixed(1)} KB)}`,
  );
}

await buildLogic();
await buildUi();

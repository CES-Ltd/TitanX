#!/usr/bin/env node
/**
 * Build builtin MCP server scripts as fully self-contained CJS bundles.
 *
 * electron-vite's externalizeDepsPlugin leaves all npm packages as require()
 * calls, which works for Electron's main process (ASAR virtual FS patches
 * require()) but fails when an external `node` process runs the script from
 * app.asar.unpacked — there is no ASAR support there.
 *
 * This script uses esbuild's programmatic API (instead of CLI flags) to avoid
 * shell-quoting issues with special characters in --define values.
 */

const esbuild = require('esbuild');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  // Bundle image generation MCP server
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/process/resources/builtinMcp/imageGenServer.ts')],
    bundle: true,
    minify: true,
    treeShaking: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(ROOT, 'out/main/builtin-mcp-image-gen.js'),
    external: ['electron'],
    tsconfig: path.join(ROOT, 'tsconfig.json'),
    loader: { '.wasm': 'empty' }, // tree-sitter wasm files not needed by image gen
    define: {
      // @office-ai/aioncli-core uses import.meta.url for version detection.
      // Provide a valid file: URL so fileURLToPath() does not throw at startup.
      'import.meta.url': JSON.stringify('file:///C:/placeholder'),
    },
  });

  // Bundle team MCP stdio bridge — spawned by Claude CLI as a standalone node process
  // Uses ESM format because the script uses top-level await
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'scripts/team-mcp-stdio.mjs')],
    bundle: true,
    minify: true,
    treeShaking: true,
    platform: 'node',
    format: 'esm',
    outfile: path.join(ROOT, 'out/main/builtin-mcp-team.mjs'),
    external: ['electron'],
    banner: {
      // Shim require() for any CJS deps that esbuild cannot statically resolve
      js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
  });
}

main().catch((err) => {
  console.error('MCP server build failed:', err);
  process.exit(1);
});

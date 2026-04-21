#!/usr/bin/env node
/**
 * Record each HTML diagram to a GIF.
 *
 * Pipeline:
 *   1. Playwright opens the HTML at a fixed viewport.
 *   2. Wait 400ms for fade-in animations to settle, then capture one frame
 *      every FRAME_INTERVAL_MS for TOTAL_DURATION_MS.
 *   3. ffmpeg converts the PNG sequence to a palette-optimized GIF.
 *
 * Frames are written to a temp dir, cleaned up after the GIF lands.
 */
import { chromium } from 'playwright';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const DIAGRAMS = [
  { html: 'fleet-master-slave.html', out: 'fleet-master-slave.gif', width: 1280, height: 720 },
  { html: 'fleet-farm-mode.html', out: 'fleet-farm-mode.gif', width: 1280, height: 720 },
  { html: 'dream-mode.html', out: 'dream-mode.gif', width: 1280, height: 760 },
];

const TOTAL_DURATION_MS = 8000; // long enough to see dream-mode's 4s-begin pulses cycle
const FRAME_INTERVAL_MS = 100; // 10 fps — small files, still readable motion
const OUTPUT_FPS = 10;

async function renderOne(d) {
  const htmlPath = path.resolve(__dirname, d.html);
  const framesDir = path.resolve(__dirname, `.frames-${path.basename(d.html, '.html')}`);
  const gifPath = path.resolve(__dirname, d.out);

  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: d.width, height: d.height },
    deviceScaleFactor: 1,
  });

  const fileUrl = url.pathToFileURL(htmlPath).toString();
  await page.goto(fileUrl, { waitUntil: 'networkidle' });
  // Wait long enough for:
  //   - all fade-in animations (max ~0.9s offset + 0.6s duration)
  //   - all `begin=*` delays on SVG animateMotion (max ~4s on dream-mode)
  // so the captured frames land mid-loop. 2000ms is a safe floor for
  // every diagram and still leaves room for a full recorded cycle
  // inside TOTAL_DURATION_MS.
  await page.waitForTimeout(2000);

  const totalFrames = Math.floor(TOTAL_DURATION_MS / FRAME_INTERVAL_MS);
  console.log(`[${d.html}] capturing ${String(totalFrames)} frames at ${String(FRAME_INTERVAL_MS)}ms intervals`);
  const start = Date.now();
  for (let i = 0; i < totalFrames; i++) {
    const target = start + i * FRAME_INTERVAL_MS;
    const wait = target - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    const framePath = path.resolve(framesDir, `frame-${String(i).padStart(4, '0')}.png`);
    await page.screenshot({
      path: framePath,
      type: 'png',
      fullPage: false,
      clip: { x: 0, y: 0, width: d.width, height: d.height },
    });
  }
  await browser.close();
  console.log(`[${d.html}] captured in ${String(Math.round((Date.now() - start) / 1000))}s`);

  // ffmpeg: palette-optimized 2-pass so the gif stays small but clean.
  const palette = path.resolve(framesDir, 'palette.png');
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-framerate',
      String(OUTPUT_FPS),
      '-i',
      path.resolve(framesDir, 'frame-%04d.png'),
      '-vf',
      `fps=${String(OUTPUT_FPS)},scale=${String(d.width)}:-1:flags=lanczos,palettegen=stats_mode=diff`,
      palette,
    ],
    { stdio: 'inherit' }
  );
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-framerate',
      String(OUTPUT_FPS),
      '-i',
      path.resolve(framesDir, 'frame-%04d.png'),
      '-i',
      palette,
      '-lavfi',
      `fps=${String(OUTPUT_FPS)},scale=${String(d.width)}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      '-loop',
      '0',
      gifPath,
    ],
    { stdio: 'inherit' }
  );

  console.log(`[${d.html}] → ${gifPath}`);
  await rm(framesDir, { recursive: true, force: true });
}

(async () => {
  for (const d of DIAGRAMS) {
    await renderOne(d);
  }
  const entries = await readdir(__dirname);
  console.log('\nFinal output:');
  for (const e of entries) {
    if (e.endsWith('.gif')) {
      console.log(`  docs/diagrams/${e}`);
    }
  }
})();

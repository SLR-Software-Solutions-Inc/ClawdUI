#!/usr/bin/env node
// Generate the ClawdUI macOS / Linux / Windows app icon.
//
// Design: Aurora-Linear gradient (violet → blue → teal) rounded-square mark
// on near-black canvas, with three asymmetric claw-mark slashes carved
// across the surface — distinctive for ClawdUI (vs CpltUI's "C + cursor"
// using the same color system).
//
// After running this script, run `npx @tauri-apps/cli icon icons/icon.png`
// from src-tauri/ to produce the full multi-size + .icns + .ico set.

import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIZE = 1024;
const OUT = join(__dirname, '../src-tauri/icons/icon.png');
mkdirSync(dirname(OUT), { recursive: true });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024">
  <defs>
    <!-- Aurora gradient (matches CpltUI / shared design-system) -->
    <linearGradient id="aurora" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7c5cff"/>
      <stop offset="55%" stop-color="#5b8cff"/>
      <stop offset="100%" stop-color="#4ad8c7"/>
    </linearGradient>

    <!-- Inner glass overlay -->
    <linearGradient id="glass" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.22)"/>
      <stop offset="60%" stop-color="rgba(255,255,255,0)"/>
    </linearGradient>

    <!-- Soft outer glow -->
    <radialGradient id="glow" cx="50%" cy="40%" r="60%">
      <stop offset="0%" stop-color="rgba(124,92,255,0.45)"/>
      <stop offset="70%" stop-color="rgba(124,92,255,0)"/>
    </radialGradient>

    <!-- Inner shadow for the carved claw marks -->
    <filter id="innerShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="5" result="blur"/>
      <feOffset dx="0" dy="2" result="off"/>
      <feComposite in="off" in2="SourceAlpha" operator="arithmetic" k2="-1" k3="1" result="shadowOnly"/>
      <feFlood flood-color="rgba(0,0,0,0.5)"/>
      <feComposite in2="shadowOnly" operator="in"/>
      <feComposite in2="SourceGraphic" operator="over"/>
    </filter>

    <!-- Slash glow — orange-warm to nod to Claude's brand without dominating -->
    <linearGradient id="slashGlow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="rgba(255,166,87,0.0)"/>
      <stop offset="50%" stop-color="rgba(255,166,87,0.85)"/>
      <stop offset="100%" stop-color="rgba(255,166,87,0.0)"/>
    </linearGradient>
  </defs>

  <!-- Outer ambient glow -->
  <rect x="0" y="0" width="1024" height="1024" fill="url(#glow)" opacity="0.85"/>

  <!-- The mark — rounded square in aurora gradient -->
  <g transform="translate(112,112)">
    <rect x="0" y="0" width="800" height="800" rx="180" ry="180" fill="url(#aurora)"/>

    <!-- Subtle glass highlight -->
    <rect x="0" y="0" width="800" height="800" rx="180" ry="180" fill="url(#glass)"/>

    <!-- Hairline border -->
    <rect x="0.5" y="0.5" width="799" height="799" rx="180" ry="180"
          fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="1.5"/>

    <!-- Three asymmetric CLAW SLASHES carved into the mark -->
    <!-- angled ~15°, varying lengths + offsets, dark inset for depth -->
    <g filter="url(#innerShadow)" transform="rotate(-18 400 400)">
      <!-- Top short slash -->
      <rect x="180" y="180" width="440" height="64" rx="32" ry="32" fill="#08090c" fill-opacity="0.92"/>
      <!-- Middle long slash (the dominant claw stroke) -->
      <rect x="100" y="368" width="600" height="76" rx="38" ry="38" fill="#08090c" fill-opacity="0.92"/>
      <!-- Bottom medium slash -->
      <rect x="220" y="556" width="400" height="64" rx="32" ry="32" fill="#08090c" fill-opacity="0.92"/>
    </g>

    <!-- Warm-glow accent stripes — Claude orange peeks through the carved gaps -->
    <g transform="rotate(-18 400 400)" opacity="0.6">
      <rect x="180" y="204" width="440" height="16" fill="url(#slashGlow)"/>
      <rect x="100" y="396" width="600" height="20" fill="url(#slashGlow)"/>
      <rect x="220" y="580" width="400" height="16" fill="url(#slashGlow)"/>
    </g>
  </g>
</svg>`;

const buf = await sharp(Buffer.from(svg))
  .resize(SIZE, SIZE)
  .png({ compressionLevel: 9 })
  .toBuffer();

writeFileSync(OUT, buf);
console.log(`wrote ${OUT} (${buf.length} bytes, ${SIZE}×${SIZE})`);

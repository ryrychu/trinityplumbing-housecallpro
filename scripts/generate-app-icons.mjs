// PLACEHOLDER ARTWORK, not final. Task 1 (mobile PWA foundation) needs real
// PNG icon files to make /app installable, but the brief's Step 4 describes a
// manual export-from-logo-artwork step that this environment cannot perform:
// no image-editing tool and no image npm library (sharp, canvas, etc.) is
// installed. Rather than block the task on design work, this script draws a
// flat #121212 (surface.page) tile with a centered gold (#f2c400, brand
// DEFAULT) square glyph, using only Node's `zlib` plus a hand-rolled PNG
// chunk writer -- no new dependency. The output is a genuinely valid,
// installable icon set, but it is a stand-in: a human must replace these
// four files with real exports of the Trinity logo before the client
// installs the app.
//
//   node scripts/generate-app-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "public", "icons");

const BG = [0x12, 0x12, 0x12]; // tailwind.config.ts surface.page
const GOLD = [0xf2, 0xc4, 0x00]; // tailwind.config.ts brand.DEFAULT

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Standard CRC-32 (ISO 3309 / PNG spec Annex D), table built once and reused.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// 8-bit RGB (color type 2), no interlace, no alpha channel anywhere -- the
// glyph is a solid fill, so there's no transparency to lose, and it means
// apple-touch-icon.png satisfies "no alpha" (iOS composites transparent
// pixels onto black, muddying the gold) for free rather than as a special case.
function encodePNG(width, height, rgbPixels) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // per-scanline filter type: 0 = "none"
    rgbPixels.copy(raw, rowStart + 1, y * stride, y * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB (truecolor, no alpha)
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method (none)

  const idat = deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// Centered square glyph at 45% of the canvas: comfortably inside the 80%
// "safe zone" every maskable-icon size needs (Android crops a circle out of
// the full square), so one draw routine covers both plain and maskable icons.
function drawTile(size) {
  const pixels = Buffer.alloc(size * size * 3);
  const glyphSize = Math.round(size * 0.45);
  const glyphStart = Math.floor((size - glyphSize) / 2);
  const glyphEnd = glyphStart + glyphSize;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inGlyph = x >= glyphStart && x < glyphEnd && y >= glyphStart && y < glyphEnd;
      const [r, g, b] = inGlyph ? GOLD : BG;
      const i = (y * size + x) * 3;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
    }
  }
  return pixels;
}

function writeIcon(filename, size) {
  const png = encodePNG(size, size, drawTile(size));
  writeFileSync(path.join(outDir, filename), png);
  console.log(`wrote ${filename} (${size}x${size}, ${png.length} bytes)`);
}

writeIcon("icon-192.png", 192);
writeIcon("icon-512.png", 512);
writeIcon("icon-maskable-512.png", 512);
writeIcon("apple-touch-icon.png", 180);

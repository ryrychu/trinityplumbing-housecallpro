// Generates the installable PWA icon set, and the favicon, from the real
// Trinity logo.
//
//   node scripts/generate-app-icons.mjs
//
// Source of truth is public/trinity-logo.svg, which is a thin SVG wrapper
// around one base64 PNG (the gold disc with the black triquetra). Decoding,
// resampling and re-encoding are all hand-rolled on top of Node's `zlib`
// because the project has no image dependency (no sharp, no canvas) and an
// icon generator that runs a handful of times is not worth adding one.
//
// These outputs replace the flat gold-square placeholders this script drew
// before the logo artwork was available.
import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const outDir = path.join(publicDir, "icons");
const logoPath = path.join(publicDir, "trinity-logo.svg");
// Next.js serves this at /favicon.ico by the app-router file convention.
const faviconPath = path.join(__dirname, "..", "src", "app", "favicon.ico");

const BG = [0x12, 0x12, 0x12]; // tailwind.config.ts surface.page

// How much of the tile the disc spans. Plain icons get an optical margin so
// the disc never touches the tile edge; maskable icons stay inside the 80%
// "safe zone" circle Android is allowed to crop to, with room to spare.
const PLAIN_COVERAGE = 0.86;
const MASKABLE_COVERAGE = 0.75;
// Favicons are tiny and conventionally bleed to the edge; the margin the tile
// icons get would only cost pixels the triquetra needs to stay legible at 16px.
const FAVICON_COVERAGE = 0.96;
const FAVICON_SIZES = [16, 32, 48, 256];

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
// disc is flattened onto the dark tile while it is resampled, so there is no
// transparency left to keep, and it means apple-touch-icon.png satisfies
// "no alpha" (iOS composites transparent pixels onto black, muddying the
// gold) for free rather than as a special case.
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

  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ICO container around already-encoded PNGs. PNG-encoded entries are the
// Vista-era extension to the format rather than the original BMP payload:
// every browser this app targets decodes them, and it means the favicon comes
// off the same encoder as the PWA icons instead of needing a second one.
function encodeICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // resource type: 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;
  images.forEach(({ size, png }, i) => {
    const entry = i * 16;
    // A single byte per axis, so 256 is stored as 0 -- the format's way of
    // spelling its own maximum.
    directory[entry] = size >= 256 ? 0 : size;
    directory[entry + 1] = size >= 256 ? 0 : size;
    directory[entry + 2] = 0; // palette entries (0 = not paletted)
    directory[entry + 3] = 0; // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

function splitChunks(png) {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("embedded logo data is not a PNG");
  }
  const chunks = [];
  for (let offset = 8; offset + 8 <= png.length; ) {
    const length = png.readUInt32BE(offset);
    chunks.push({
      type: png.toString("ascii", offset + 4, offset + 8),
      data: png.subarray(offset + 8, offset + 8 + length),
    });
    offset += length + 12; // length + type + data + CRC
  }
  return chunks;
}

function paeth(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : upLeft;
}

// Pulls the artwork out of the SVG wrapper and returns straight RGBA. The
// wrapper's own viewBox and offsets are ignored on purpose: icons are framed
// from the artwork's own bounds (see squareRegion), so whitespace baked into
// the SVG cannot shrink the disc inside the tile.
function decodeLogo() {
  const svg = readFileSync(logoPath, "utf8");
  const embedded = svg.match(/href="data:image\/png;base64,([^"]+)"/);
  if (!embedded) {
    throw new Error(
      "public/trinity-logo.svg no longer embeds a base64 PNG; this script reads " +
        "the artwork out of that wrapper and needs updating for real vector paths",
    );
  }

  const chunks = splitChunks(Buffer.from(embedded[1], "base64"));
  const chunk = (type) => chunks.find((c) => c.type === type)?.data;

  const ihdr = chunk("IHDR");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  // Only the encoding the current logo actually uses is supported. A
  // re-export in another format should fail loudly here rather than quietly
  // produce garbled icons.
  if (depth !== 8 || colorType !== 3 || interlace !== 0) {
    throw new Error(
      `unsupported logo PNG (bit depth ${depth}, color type ${colorType}, ` +
        `interlace ${interlace}); expected 8-bit non-interlaced palette`,
    );
  }

  const palette = chunk("PLTE");
  // tRNS on a palette image is a per-index alpha table, and it may be shorter
  // than the palette -- indices past its end are fully opaque.
  const trns = chunk("tRNS") ?? Buffer.alloc(0);
  const raw = inflateSync(
    Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)),
  );

  const pixels = new Uint8Array(width * height * 4);
  // 8-bit palette means one byte per pixel, so the byte the Sub/Paeth filters
  // look back to is simply the previous one on the line.
  let prior = new Uint8Array(width);
  let line = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width + 1);
    const filter = raw[rowStart];
    for (let x = 0; x < width; x++) {
      const value = raw[rowStart + 1 + x];
      const left = x >= 1 ? line[x - 1] : 0;
      const up = prior[x];
      const upLeft = x >= 1 ? prior[x - 1] : 0;
      let index;
      switch (filter) {
        case 0:
          index = value;
          break;
        case 1:
          index = value + left;
          break;
        case 2:
          index = value + up;
          break;
        case 3:
          index = value + ((left + up) >> 1);
          break;
        case 4:
          index = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`unknown PNG scanline filter ${filter} on row ${y}`);
      }
      index &= 0xff;
      line[x] = index;

      const out = (y * width + x) * 4;
      pixels[out] = palette[index * 3];
      pixels[out + 1] = palette[index * 3 + 1];
      pixels[out + 2] = palette[index * 3 + 2];
      pixels[out + 3] = index < trns.length ? trns[index] : 0xff;
    }
    const swap = prior;
    prior = line;
    line = swap;
  }

  return { width, height, pixels };
}

// The smallest square containing every non-transparent pixel, centered on the
// artwork. Framing from this rather than from the file dimensions keeps the
// disc the same visual size in every icon even if the logo is re-exported
// with different padding around it.
function squareRegion({ width, height, pixels }) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error("logo artwork is fully transparent");

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const side = Math.max(w, h);
  return { x: minX - (side - w) / 2, y: minY - (side - h) / 2, side };
}

// Box-filter resample of `region` down to `size` x `size`, flattened onto BG.
// Samples accumulate premultiplied by alpha, which is what stops the
// antialiased rim of the disc from picking up a bright halo; compositing
// premultiplied colour onto an opaque background is then just
// `src + bg * (1 - coverage)`. Samples outside the artwork count as fully
// transparent, so a region hanging over the edge simply reads as tile.
function renderGlyph({ width, height, pixels }, region, size) {
  const rgb = Buffer.alloc(size * size * 3);
  const scale = region.side / size;

  for (let ty = 0; ty < size; ty++) {
    const top = region.y + ty * scale;
    const bottom = top + scale;
    for (let tx = 0; tx < size; tx++) {
      const left = region.x + tx * scale;
      const right = left + scale;

      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      let weight = 0;
      for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
        const rows = Math.min(bottom, sy + 1) - Math.max(top, sy);
        for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
          const w = rows * (Math.min(right, sx + 1) - Math.max(left, sx));
          weight += w;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
          const o = (sy * width + sx) * 4;
          const a = (pixels[o + 3] / 255) * w;
          r += pixels[o] * a;
          g += pixels[o + 1] * a;
          b += pixels[o + 2] * a;
          alpha += a;
        }
      }

      const coverage = alpha / weight;
      const i = (ty * size + tx) * 3;
      rgb[i] = Math.round(r / weight + BG[0] * (1 - coverage));
      rgb[i + 1] = Math.round(g / weight + BG[1] * (1 - coverage));
      rgb[i + 2] = Math.round(b / weight + BG[2] * (1 - coverage));
    }
  }
  return rgb;
}

function drawTile(logo, size, coverage) {
  const pixels = Buffer.alloc(size * size * 3);
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = BG[0];
    pixels[i + 1] = BG[1];
    pixels[i + 2] = BG[2];
  }

  const glyphSize = Math.round(size * coverage);
  const glyph = renderGlyph(logo, squareRegion(logo), glyphSize);
  const offset = Math.floor((size - glyphSize) / 2);
  for (let y = 0; y < glyphSize; y++) {
    glyph.copy(
      pixels,
      ((y + offset) * size + offset) * 3,
      y * glyphSize * 3,
      (y + 1) * glyphSize * 3,
    );
  }
  return pixels;
}

const logo = decodeLogo();
console.log(`source artwork ${logo.width}x${logo.height} from public/trinity-logo.svg`);

const ICONS = [
  ["icon-192.png", 192, PLAIN_COVERAGE],
  ["icon-512.png", 512, PLAIN_COVERAGE],
  ["icon-maskable-512.png", 512, MASKABLE_COVERAGE],
  ["apple-touch-icon.png", 180, PLAIN_COVERAGE],
];

for (const [filename, size, coverage] of ICONS) {
  const png = encodePNG(size, size, drawTile(logo, size, coverage));
  writeFileSync(path.join(outDir, filename), png);
  console.log(`wrote ${filename} (${size}x${size}, ${png.length} bytes)`);
}

// The favicon is not decoration here. Chrome falls back to it whenever the
// page being installed from does not link the manifest, and only /app/* links
// it -- so an install started from /, /dashboard or /dispatch gets the
// favicon, which until now was the create-next-app Vercel triangle.
const favicon = encodeICO(
  FAVICON_SIZES.map((size) => ({
    size,
    png: encodePNG(size, size, drawTile(logo, size, FAVICON_COVERAGE)),
  })),
);
writeFileSync(faviconPath, favicon);
console.log(`wrote src/app/favicon.ico (${FAVICON_SIZES.join("/")}, ${favicon.length} bytes)`);

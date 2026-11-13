// lib/upi/qr.js - Zero-dependency, pure JavaScript QR Code (Model 2) SVG generator for UPI strings.
// Generates standard scannable QR codes for NPCI upi:// payment URIs.
// Fully compliant with ISO/IEC 18004:2015 specification (Versions 1 through 14, EC Level M).

import { HttpError } from '../http.js';

export class QrPayloadTooLargeError extends HttpError {
  constructor(byteLength, maxCapacity) {
    super(
      400,
      'payload_too_large',
      `Payment URI length (${byteLength} bytes) exceeds maximum supported QR capacity (${maxCapacity} bytes)`
    );
    this.name = 'QrPayloadTooLargeError';
    this.byteLength = byteLength;
    this.maxCapacity = maxCapacity;
  }
}

// Galois Field GF(256) math for Reed-Solomon error correction
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    EXP[i + 255] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 128 ? 0x11d : 0);
  }
  LOG[0] = 0;
})();

function gfMul(x, y) {
  return x === 0 || y === 0 ? 0 : EXP[LOG[x] + LOG[y]];
}

function rsGenerator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function rsEncode(data, ecCount) {
  const gen = rsGenerator(ecCount);
  const res = new Uint8Array(data.length + ecCount);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        res[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return res.slice(data.length);
}

// Version table for Byte mode, Error Correction Level M (ISO/IEC 18004 Table 9)
// Capacities: [version, totalCodewords, ecCodewordsPerBlock, size, dataCap, groups]
export const VERSIONS = [
  null,
  { version: 1, total: 26, ec: 10, size: 21, dataCap: 14, groups: [{ blocks: 1, dataLen: 16 }] },
  { version: 2, total: 44, ec: 16, size: 25, dataCap: 26, groups: [{ blocks: 1, dataLen: 28 }] },
  { version: 3, total: 70, ec: 26, size: 29, dataCap: 42, groups: [{ blocks: 1, dataLen: 44 }] },
  { version: 4, total: 100, ec: 18, size: 33, dataCap: 62, groups: [{ blocks: 2, dataLen: 32 }] },
  { version: 5, total: 134, ec: 24, size: 37, dataCap: 84, groups: [{ blocks: 2, dataLen: 43 }] },
  { version: 6, total: 172, ec: 16, size: 41, dataCap: 106, groups: [{ blocks: 4, dataLen: 27 }] },
  { version: 7, total: 196, ec: 18, size: 45, dataCap: 122, groups: [{ blocks: 4, dataLen: 31 }] },
  { version: 8, total: 242, ec: 22, size: 49, dataCap: 152, groups: [{ blocks: 2, dataLen: 38 }, { blocks: 2, dataLen: 39 }] },
  { version: 9, total: 292, ec: 22, size: 53, dataCap: 180, groups: [{ blocks: 3, dataLen: 36 }, { blocks: 2, dataLen: 37 }] },
  { version: 10, total: 346, ec: 26, size: 57, dataCap: 213, groups: [{ blocks: 4, dataLen: 43 }, { blocks: 1, dataLen: 44 }] },
  { version: 11, total: 404, ec: 30, size: 61, dataCap: 251, groups: [{ blocks: 1, dataLen: 50 }, { blocks: 4, dataLen: 51 }] },
  { version: 12, total: 466, ec: 22, size: 65, dataCap: 287, groups: [{ blocks: 6, dataLen: 36 }, { blocks: 2, dataLen: 37 }] },
  { version: 13, total: 532, ec: 22, size: 69, dataCap: 331, groups: [{ blocks: 8, dataLen: 37 }, { blocks: 1, dataLen: 38 }] },
  { version: 14, total: 581, ec: 24, size: 73, dataCap: 362, groups: [{ blocks: 4, dataLen: 40 }, { blocks: 5, dataLen: 41 }] }
];

export const MAX_SUPPORTED_VERSION = 14;
export const MAX_QR_PAYLOAD_BYTES = VERSIONS[MAX_SUPPORTED_VERSION].dataCap;

export const ALIGNMENT_PATTERN_POS = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66]
];

// Mask evaluation formulas
function getMaskBit(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return false;
  }
}

// ISO/IEC 18004 Format Information Generator (BCH 15, 5)
const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

export function getFormatInfoBits(ecBit, mask) {
  const data = (ecBit << 3) | mask;
  let d = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((d >> i) & 1) d ^= (G15 << (i - 10));
  }
  return ((data << 10) | d) ^ G15_MASK;
}

// ISO/IEC 18004 Version Information Generator (BCH 18, 6)
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);

export function getVersionInfoBits(v) {
  let d = v << 12;
  for (let i = 17; i >= 12; i--) {
    if ((d >> i) & 1) d ^= (G18 << (i - 12));
  }
  return (v << 12) | d;
}

/**
 * Encodes text into a QR code matrix.
 * Returns { version, size, modules, get(x, y), matrix }
 */
export function encodeQrMatrix(text) {
  const bytes = Buffer.from(text, 'utf8');
  let ver = null;
  for (let v = 1; v < VERSIONS.length; v++) {
    if (bytes.length <= VERSIONS[v].dataCap) {
      ver = VERSIONS[v];
      break;
    }
  }
  if (!ver) {
    throw new QrPayloadTooLargeError(bytes.length, MAX_QR_PAYLOAD_BYTES);
  }

  // Build bitstream: Mode 4 (Byte) + Length (8 or 16 bits) + data + terminator + pad
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  pushBits(0b0100, 4); // Byte mode indicator
  pushBits(bytes.length, ver.version >= 10 ? 16 : 8); // Character count
  for (const b of bytes) pushBits(b, 8);

  const totalDataCodewords = ver.groups.reduce((acc, g) => acc + g.blocks * g.dataLen, 0);
  const totalDataBits = totalDataCodewords * 8;
  const termLen = Math.min(4, totalDataBits - bits.length);
  for (let i = 0; i < termLen; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bits.length < totalDataBits) {
    pushBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  // Convert to data codewords
  const dataCodewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataCodewords.push(b);
  }

  // Interleave blocks according to ISO/IEC 18004 Table 9 and compute Reed-Solomon EC
  const dataBlocks = [];
  const ecBlocks = [];
  let cwOffset = 0;

  for (const group of ver.groups) {
    for (let b = 0; b < group.blocks; b++) {
      const blockData = dataCodewords.slice(cwOffset, cwOffset + group.dataLen);
      cwOffset += group.dataLen;
      dataBlocks.push(blockData);
      ecBlocks.push(Array.from(rsEncode(blockData, ver.ec)));
    }
  }

  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  const finalCodewords = [];
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < dataBlocks.length; b++) {
      if (i < dataBlocks[b].length) {
        finalCodewords.push(dataBlocks[b][i]);
      }
    }
  }
  for (let i = 0; i < ver.ec; i++) {
    for (let b = 0; b < ecBlocks.length; b++) {
      finalCodewords.push(ecBlocks[b][i]);
    }
  }

  // Convert to matrix placement stream
  const matrixBits = [];
  for (const cw of finalCodewords) {
    for (let i = 7; i >= 0; i--) matrixBits.push((cw >> i) & 1);
  }

  const size = ver.size;
  const matrix = Array.from({ length: size }, () => new Int8Array(size).fill(0));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  function setFinder(r, c) {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const y = r + i;
        const x = c + j;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const on = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
                   (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
                   (i >= 2 && i <= 4 && j >= 2 && j <= 4);
        matrix[y][x] = on ? 1 : 0;
        reserved[y][x] = 1;
      }
    }
  }

  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  // REV-01: Correct alignment-pattern placement for all supported versions.
  // Patterns are placed at all grid coordinates EXCEPT where they overlap the three finder patterns.
  // Placed BEFORE timing patterns so timing pattern reservation does NOT skip valid alignment modules.
  const alignPos = ALIGNMENT_PATTERN_POS[ver.version] || [];
  const alignLen = alignPos.length;
  for (let i = 0; i < alignLen; i++) {
    for (let j = 0; j < alignLen; j++) {
      // Exclude top-left (0, 0), bottom-left (alignLen - 1, 0), and top-right (0, alignLen - 1)
      if ((i === 0 && j === 0) || (i === 0 && j === alignLen - 1) || (i === alignLen - 1 && j === 0)) {
        continue;
      }
      const r = alignPos[i];
      const c = alignPos[j];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = dr === -2 || dr === 2 || dc === -2 || dc === 2 || (dr === 0 && dc === 0);
          matrix[r + dr][c + dc] = on ? 1 : 0;
          reserved[r + dr][c + dc] = 1;
        }
      }
    }
  }

  // Timing patterns (connect finders, filling non-reserved modules)
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) { matrix[6][i] = i % 2 === 0 ? 1 : 0; reserved[6][i] = 1; }
    if (!reserved[i][6]) { matrix[i][6] = i % 2 === 0 ? 1 : 0; reserved[i][6] = 1; }
  }

  // Version information for QR versions 7 and higher (ISO/IEC 18004 Section 8.10)
  if (ver.version >= 7) {
    const vbits = getVersionInfoBits(ver.version);
    for (let i = 0; i < 18; i++) {
      const bit = (vbits >> i) & 1;
      const r = Math.floor(i / 3);
      const c = (i % 3) + size - 8 - 3;
      // Top-right 3x6 block
      matrix[r][c] = bit;
      reserved[r][c] = 1;
      // Bottom-left 6x3 block
      matrix[c][r] = bit;
      reserved[c][r] = 1;
    }
  }

  // Reserve format info area (around finder patterns and dark module)
  for (let i = 0; i < 15; i++) {
    // Vertical positions
    if (i < 6) reserved[i][8] = 1;
    else if (i < 8) reserved[i + 1][8] = 1;
    else reserved[size - 15 + i][8] = 1;

    // Horizontal positions
    if (i < 8) reserved[8][size - i - 1] = 1;
    else if (i < 9) reserved[8][15 - i - 1 + 1] = 1;
    else reserved[8][15 - i - 1] = 1;
  }
  matrix[size - 8][8] = 1; // Mandatory Dark Module (ISO 18004 8.7.2.2)
  reserved[size - 8][8] = 1;

  // Mask 0 (standard checkerboard mask)
  const chosenMask = 0;

  // Place data bits in 2-column zig-zag traversal
  let bitIdx = 0;
  let dir = -1;
  let y = size - 1;
  for (let x = size - 1; x > 0; x -= 2) {
    if (x === 6) x--; // Skip vertical timing column
    while (true) {
      for (let col = 0; col < 2; col++) {
        const curX = x - col;
        if (!reserved[y][curX]) {
          const bit = bitIdx < matrixBits.length ? matrixBits[bitIdx++] : 0;
          const maskBit = getMaskBit(chosenMask, y, curX);
          matrix[y][curX] = bit ^ (maskBit ? 1 : 0);
        }
      }
      const nextY = y + dir;
      if (nextY < 0 || nextY >= size) {
        dir = -dir;
        break;
      }
      y = nextY;
    }
  }

  // Format info placement for EC Level M (bit 0) and Mask 0
  const formatInfo = getFormatInfoBits(0, chosenMask);
  for (let i = 0; i < 15; i++) {
    const mod = (formatInfo >> i) & 1;

    // Vertical format info modules
    if (i < 6) matrix[i][8] = mod;
    else if (i < 8) matrix[i + 1][8] = mod;
    else matrix[size - 15 + i][8] = mod;

    // Horizontal format info modules
    if (i < 8) matrix[8][size - i - 1] = mod;
    else if (i < 9) matrix[8][15 - i - 1 + 1] = mod;
    else matrix[8][15 - i - 1] = mod;
  }
  matrix[size - 8][8] = 1; // Ensure Dark Module is preserved

  return {
    version: ver.version,
    size,
    get: (row, col) => matrix[row][col] === 1,
    matrix
  };
}

/**
 * Generates an SVG string representation of a UPI QR code.
 */
export function generateQrSvg(upiUri, { size = 280, margin = 4, darkColor = '#000000', lightColor = '#ffffff' } = {}) {
  const qr = encodeQrMatrix(upiUri);
  const totalCells = qr.size + margin * 2;
  const cellSize = (size / totalCells).toFixed(3);

  let pathData = '';
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.get(r, c)) {
        const x = ((c + margin) * cellSize).toFixed(2);
        const y = ((r + margin) * cellSize).toFixed(2);
        pathData += `M${x},${y}h${cellSize}v${cellSize}h-${cellSize}z `;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges" aria-label="UPI Payment QR Code" role="img">
  <rect width="${size}" height="${size}" fill="${lightColor}" rx="12"/>
  <path d="${pathData.trim()}" fill="${darkColor}"/>
</svg>`;
}

/**
 * Generates a standard NPCI UPI URI string.
 * Never truncates payment details (preserves full note and order parameters).
 */
export function buildUpiUri({ vpa, name, amountPaise, orderId, note = 'NIGHTLIFEZ Event Ticket' }) {
  if (!vpa || !orderId || amountPaise === undefined || amountPaise === null) {
    throw new Error('Missing required UPI parameters: vpa, orderId, and amountPaise are mandatory');
  }
  const amountRupees = (Number(amountPaise) / 100).toFixed(2);
  const params = new URLSearchParams({
    pa: vpa,
    pn: name,
    am: amountRupees,
    cu: 'INR',
    tr: orderId,
    tn: String(note)
  });
  return `upi://pay?${params.toString()}`;
}

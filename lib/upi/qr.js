// lib/upi/qr.js - Zero-dependency, pure JavaScript QR Code (Model 2) SVG generator for UPI strings.
// Generates standard scannable QR codes for NPCI upi:// payment URIs.

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
      next[j] ^= gfMul(g[j], EXP[i]);
      next[j + 1] ^= g[j];
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

// Version table for Byte mode, Error Correction Level M
// Capacities: [version, totalCodewords, ecCodewordsPerBlock, size, dataCap, groups]
const VERSIONS = [
  null,
  { version: 1, total: 26, ec: 10, size: 21, dataCap: 14, groups: [{ blocks: 1, dataLen: 16 }] },
  { version: 2, total: 44, ec: 16, size: 25, dataCap: 26, groups: [{ blocks: 1, dataLen: 28 }] },
  { version: 3, total: 70, ec: 26, size: 29, dataCap: 42, groups: [{ blocks: 1, dataLen: 44 }] },
  { version: 4, total: 100, ec: 18, size: 33, dataCap: 62, groups: [{ blocks: 2, dataLen: 32 }] },
  { version: 5, total: 134, ec: 24, size: 37, dataCap: 84, groups: [{ blocks: 2, dataLen: 43 }] },
  { version: 6, total: 172, ec: 16, size: 41, dataCap: 106, groups: [{ blocks: 4, dataLen: 27 }] },
  { version: 7, total: 196, ec: 18, size: 45, dataCap: 122, groups: [{ blocks: 2, dataLen: 31 }, { blocks: 2, dataLen: 32 }] },
  { version: 8, total: 242, ec: 22, size: 49, dataCap: 152, groups: [{ blocks: 2, dataLen: 38 }, { blocks: 2, dataLen: 39 }] },
  { version: 9, total: 292, ec: 22, size: 53, dataCap: 180, groups: [{ blocks: 3, dataLen: 36 }, { blocks: 2, dataLen: 37 }] },
  { version: 10, total: 346, ec: 26, size: 57, dataCap: 213, groups: [{ blocks: 4, dataLen: 43 }, { blocks: 1, dataLen: 44 }] }
];

const ALIGNMENT_PATTERN_POS = [
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
  [6, 28, 50]
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

/**
 * Encodes text into a QR code matrix.
 * Returns { size, modules, get(x, y) }
 */
export function encodeQrMatrix(text) {
  const bytes = Buffer.from(text, 'utf8');
  let ver = null;
  for (let v = 1; v <= 10; v++) {
    if (bytes.length <= VERSIONS[v].dataCap) {
      ver = VERSIONS[v];
      break;
    }
  }
  if (!ver) throw new Error(`Text too long for QR code (${bytes.length} bytes; max 213 supported)`);

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
  const matrix = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
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

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) { matrix[6][i] = i % 2 === 0 ? 1 : 0; reserved[6][i] = 1; }
    if (!reserved[i][6]) { matrix[i][6] = i % 2 === 0 ? 1 : 0; reserved[i][6] = 1; }
  }

  // Alignment patterns
  const alignPos = ALIGNMENT_PATTERN_POS[ver.version] || [];
  for (const r of alignPos) {
    for (const c of alignPos) {
      if (reserved[r][c]) continue;
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
          const on = Math.max(Math.abs(i), Math.abs(j)) !== 1;
          matrix[r + i][c + j] = on ? 1 : 0;
          reserved[r + i][c + j] = 1;
        }
      }
    }
  }

  // Reserve format info area
  for (let i = 0; i < 9; i++) {
    reserved[8][i] = 1;
    reserved[i][8] = 1;
    reserved[8][size - 1 - i] = 1;
    reserved[size - 1 - i][8] = 1;
  }
  matrix[size - 8][8] = 1; // Dark module
  reserved[size - 8][8] = 1;

  // Mask 0 (simple standard checkerboard)
  const chosenMask = 0;

  // Place data bits
  let bitIdx = 0;
  let dir = -1;
  let y = size - 1;
  for (let x = size - 1; x > 0; x -= 2) {
    if (x === 6) x--;
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

  // Format info for EC Level M (00) and Mask 0 (000) = 00000 -> 0x5412 XOR masked = 0x5412
  // Precomputed format info for (M, 0): 0b101010000010010 ^ 0b101010000010010 = 0...
  // EC Level M = 00, Mask 0 = 000. Data = 00000. BCH = 0000000000. XOR mask = 101010000010010 (0x5412)
  const formatInfo = 0x5412;
  for (let i = 0; i < 15; i++) {
    const bit = (formatInfo >> (14 - i)) & 1;
    // Region 1: Top-Left around finder pattern
    if (i < 6) matrix[8][i] = bit;
    else if (i < 8) matrix[8][i + 1] = bit;
    else if (i === 8) matrix[7][8] = bit;
    else matrix[14 - i][8] = bit;

    // Region 2: Bottom-Left (bits 0..6) and Top-Right (bits 7..14)
    // Position (size - 8, 8) is the mandatory Dark Module and must never be overwritten
    if (i < 7) matrix[size - 1 - i][8] = bit;
    else matrix[8][size - 15 + i] = bit;
  }

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
 */
export function buildUpiUri({ vpa, name, amountPaise, orderId, note = 'NIGHTLIFEZ Event Ticket' }) {
  const amountRupees = (amountPaise / 100).toFixed(2);
  const params = new URLSearchParams({
    pa: vpa,
    pn: name,
    am: amountRupees,
    cu: 'INR',
    tr: orderId,
    tn: note.slice(0, 50)
  });
  return `upi://pay?${params.toString()}`;
}

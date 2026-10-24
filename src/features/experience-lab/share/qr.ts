// A small QR code encoder (ISO/IEC 18004), so sharing her site needs no
// service and no dependency: the code is drawn in the browser, nothing is
// sent anywhere. Byte mode (UTF-8), error correction level M (about 15 %
// of the code can be damaged or covered and it still reads), versions 1
// to 10: up to 213 bytes, far more than a link needs. The structure
// follows the standard step by step: data bits, Reed–Solomon blocks,
// function patterns, zigzag placement, the best of the eight masks.

type Block = { count: number; data: number };

// Level M: error-correction codewords per block, and the data blocks.
const levelM: { ec: number; blocks: Block[] }[] = [
  { ec: 10, blocks: [{ count: 1, data: 16 }] },
  { ec: 16, blocks: [{ count: 1, data: 28 }] },
  { ec: 26, blocks: [{ count: 1, data: 44 }] },
  { ec: 18, blocks: [{ count: 2, data: 32 }] },
  { ec: 24, blocks: [{ count: 2, data: 43 }] },
  { ec: 16, blocks: [{ count: 4, data: 27 }] },
  { ec: 18, blocks: [{ count: 4, data: 31 }] },
  {
    ec: 22,
    blocks: [
      { count: 2, data: 38 },
      { count: 2, data: 39 },
    ],
  },
  {
    ec: 22,
    blocks: [
      { count: 3, data: 36 },
      { count: 2, data: 37 },
    ],
  },
  {
    ec: 26,
    blocks: [
      { count: 4, data: 43 },
      { count: 1, data: 44 },
    ],
  },
];

const alignments: number[][] = [
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
];

const dataCapacity = (version: number) =>
  levelM[version - 1]!.blocks.reduce(
    (sum, block) => sum + block.count * block.data,
    0,
  );

// --- Reed–Solomon over GF(2^8), polynomial 0x11D ------------------------------

function multiply(x: number, y: number) {
  let z = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> bit) & 1) * x;
  }
  return z;
}

function divisor(degree: number) {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = multiply(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = multiply(root, 0x02);
  }
  return result;
}

function remainder(data: number[], generator: number[]) {
  const result = generator.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    generator.forEach((coefficient, index) => {
      result[index]! ^= multiply(coefficient, factor);
    });
  }
  return result;
}

// --- Data codewords --------------------------------------------------------------

function codewords(bytes: Uint8Array, version: number) {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let bit = length - 1; bit >= 0; bit -= 1)
      bits.push((value >>> bit) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach((byte) => push(byte, 8));
  const capacity = dataCapacity(version) * 8;
  push(0, Math.min(4, capacity - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    data.push(bits.slice(index, index + 8).reduce((a, b) => (a << 1) | b, 0));
  }
  for (let pad = 0xec; data.length < capacity / 8; pad ^= 0xec ^ 0x11)
    data.push(pad);

  // Split into blocks, add each block's error correction, interleave.
  const { ec, blocks } = levelM[version - 1]!;
  const generator = divisor(ec);
  const split: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  for (const block of blocks) {
    for (let count = 0; count < block.count; count += 1) {
      const part = data.slice(offset, offset + block.data);
      offset += block.data;
      split.push({ data: part, ec: remainder(part, generator) });
    }
  }
  const result: number[] = [];
  const longest = Math.max(...split.map((block) => block.data.length));
  for (let index = 0; index < longest; index += 1)
    for (const block of split)
      if (index < block.data.length) result.push(block.data[index]!);
  for (let index = 0; index < ec; index += 1)
    for (const block of split) result.push(block.ec[index]!);
  return result;
}

// --- The matrix ----------------------------------------------------------------------

const masks: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function build(version: number, data: number[], mask: number) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const fixed = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const set = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    fixed[y]![x] = true;
  };

  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy += 1)
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, distance !== 2 && distance !== 4);
      }
  }
  const centres = alignments[version - 1]!;
  const last = centres.length - 1;
  centres.forEach((cx, i) =>
    centres.forEach((cy, j) => {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === last) ||
        (i === last && j === 0)
      )
        return;
      for (let dy = -2; dy <= 2; dy += 1)
        for (let dx = -2; dx <= 2; dx += 1)
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );

  // Format: level M (00) and the mask, BCH-protected, in both copies.
  const format = mask; // (0b00 << 3) | mask
  let rem = format;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const formatBits = ((format << 10) | rem) ^ 0x5412;
  const bit = (value: number, index: number) => ((value >>> index) & 1) !== 0;
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(formatBits, i));
  set(8, 7, bit(formatBits, 6));
  set(8, 8, bit(formatBits, 7));
  set(7, 8, bit(formatBits, 8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(formatBits, i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(formatBits, i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(formatBits, i));
  set(8, size - 8, true); // the dark module

  if (version >= 7) {
    let vrem = version;
    for (let i = 0; i < 12; i += 1)
      vrem = (vrem << 1) ^ ((vrem >>> 11) * 0x1f25);
    const versionBits = (version << 12) | vrem;
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(versionBits, i));
      set(b, a, bit(versionBits, i));
    }
  }

  // Data, two columns at a time, zigzagging up and down from the right.
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (fixed[y]![x] || index >= data.length * 8) continue;
        modules[y]![x] = bit(data[index >>> 3]!, 7 - (index & 7));
        index += 1;
      }
    }
  }

  const apply = masks[mask]!;
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1)
      if (!fixed[y]![x] && apply(x, y)) modules[y]![x] = !modules[y]![x];
  return modules;
}

/** The standard's penalty: lower reads better (runs, blocks, finder-likes, balance). */
function penalty(modules: boolean[][]) {
  const size = modules.length;
  let score = 0;
  const lines = [
    ...modules,
    ...modules.map((_, x) => modules.map((row) => row[x]!)),
  ];
  const finderLike = [true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && line[i] === line[i - 1]) run += 1;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    for (let i = 0; i + 7 <= size; i += 1) {
      if (!finderLike.every((value, k) => line[i + k] === value)) continue;
      const lightBefore = [1, 2, 3, 4].every((k) => i - k < 0 || !line[i - k]);
      const lightAfter = [0, 1, 2, 3].every(
        (k) => i + 7 + k >= size || !line[i + 7 + k],
      );
      if (lightBefore || lightAfter) score += 40;
    }
  }
  for (let y = 0; y + 1 < size; y += 1)
    for (let x = 0; x + 1 < size; x += 1) {
      const value = modules[y]![x];
      if (
        modules[y]![x + 1] === value &&
        modules[y + 1]![x] === value &&
        modules[y + 1]![x + 1] === value
      )
        score += 3;
    }
  const dark = modules.flat().filter(Boolean).length;
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** The modules of the QR code for `text` (true: dark), or null if too long. */
export function qrModules(text: string): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  // Mode (4 bits) + count (8 or 16) + data must fit.
  while (
    version <= 10 &&
    4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCapacity(version) * 8
  )
    version += 1;
  if (version > 10) return null;
  const data = codewords(bytes, version);
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = build(version, data, mask);
    const score = penalty(modules);
    if (score < bestScore) {
      best = modules;
      bestScore = score;
    }
  }
  return best;
}

/** An SVG of the code with its quiet zone (4 modules), in two colours. */
export function qrSvg(
  text: string,
  { dark = "#000000", light = "#FFFFFF" } = {},
): string | null {
  const modules = qrModules(text);
  if (!modules) return null;
  const size = modules.length + 8;
  let path = "";
  modules.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) path += `M${x + 4} ${y + 4}h1v1h-1z`;
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}

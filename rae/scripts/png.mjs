// A minimal PNG writer for the asset generators: 8 bits, RGBA, no interlace, filter 0 on every row.
// No dependency, and the pixels round-trip exactly; the compressed bytes may differ between Node versions,
// which is why the tests compare decoded pixels rather than files.

import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
}

/** `pixels` is width * height * 4 bytes of RGBA, rows top to bottom. */
export function encodePng(width, height, pixels) {
    if (pixels.length !== width * height * 4) throw new Error(`expected ${width * height * 4} bytes of pixels, got ${pixels.length}`);

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 6, 0, 0, 0], 8);                     // 8 bits, RGBA, deflate, filter method 0, no interlace

    const rows = [];
    for (let y = 0; y < height; y++) rows.push(Buffer.from([0]), pixels.subarray(y * width * 4, (y + 1) * width * 4));

    return Buffer.concat([
        SIGNATURE,
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(Buffer.concat(rows))),
        chunk("IEND", Buffer.alloc(0))
    ]);
}

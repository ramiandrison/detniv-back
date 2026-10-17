#!/usr/bin/env python3
"""Generate simple PNG icons for the extension (no external deps)."""
import struct, zlib, os

def make_png(width, height, pixels):
    """pixels: list of rows, each row is list of (r,g,b,a)."""
    raw = b""
    for row in pixels:
        raw += b"\x00"  # filter: none
        for r, g, b, a in row:
            raw += struct.pack("BBBB", r, g, b, a)

    def chunk(ctype, data):
        c = ctype + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )

def generate(size):
    cx, cy = size / 2, size / 2
    r_outer = size * 0.46
    r_inner = size * 0.34
    # Camera body dimensions
    bw, bh = size * 0.52, size * 0.38
    by = cy + size * 0.05  # body center y
    # Lens
    lr = size * 0.14
    # Viewfinder bump
    vw, vh = size * 0.16, size * 0.06
    vy = by - bh / 2

    # Colors: Black & Yellow theme
    BG = (13, 13, 13, 255)          # #0D0D0D black
    YELLOW = (255, 214, 0, 255)     # #FFD600 yellow
    DARK = (40, 40, 40, 255)        # dark gray for lens interior

    pixels = []
    for y in range(size):
        row = []
        for x in range(size):
            dx, dy = x - cx, y - cy
            dist = (dx * dx + dy * dy) ** 0.5

            if dist <= r_outer:
                # Rounded background
                c = BG

                # Camera body (rounded rect)
                bx, byc = cx, by
                hw, hh = bw / 2, bh / 2
                rx = abs(x - bx) - hw + size * 0.04
                ry = abs(y - byc) - hh + size * 0.04
                if rx < 0 and ry < 0:
                    c = YELLOW
                elif rx < 0 and ry < size * 0.04:
                    # rounded corners
                    if ry + size * 0.04 > 0 and abs(ry) < size * 0.04:
                        corner_x = hw - size * 0.04
                        corner_y = hh - size * 0.04
                        qx = abs(x - bx) - corner_x
                        qy = abs(y - byc) - corner_y
                        if qx > 0 and qy > 0 and (qx * qx + qy * qy) ** 0.5 < size * 0.04:
                            c = YELLOW

                # Lens (circle)
                ldx, ldy = x - cx, y - (by + size * 0.01)
                ldist = (ldx * ldx + ldy * ldy) ** 0.5
                if ldist < lr:
                    c = DARK
                elif ldist < lr + size * 0.015:
                    c = YELLOW

                # Viewfinder bump
                if abs(x - cx) < vw / 2 and vy - vh < y < vy + size * 0.02:
                    if y < byc - hh + size * 0.06:
                        c = YELLOW

                # Small indicator dot (top-left of body)
                idx, idy = x - (cx - bw * 0.28), y - (by - bh * 0.22)
                if (idx * idx + idy * idy) ** 0.5 < size * 0.025:
                    c = BG

                row.append(c)
            elif dist <= r_outer + size * 0.02:
                # Anti-aliased edge
                t = 1.0 - (dist - r_outer) / (size * 0.02)
                c = (
                    int(BG[0] * t),
                    int(BG[1] * t),
                    int(BG[2] * t),
                    int(255 * t),
                )
                row.append(c)
            else:
                row.append((0, 0, 0, 0))
        pixels.append(row)
    return pixels

os.makedirs("icons", exist_ok=True)
for sz in (16, 32, 48, 96, 128):
    png = make_png(sz, sz, generate(sz))
    path = f"icons/icon{sz}.png"
    with open(path, "wb") as f:
        f.write(png)
    print(f"  {path}  ({len(png)} bytes)")
print("Icons generated.")

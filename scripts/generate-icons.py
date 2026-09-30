"""Render the SizeSnap placement mark. Shapes match extension/icons/mark.svg."""
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1] / 'extension'

def rounded(x, y, left, top, right, bottom, radius):
    if not (left <= x <= right and top <= y <= bottom):
        return False
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2

def color(x, y):
    if not rounded(x, y, 3, 3, 125, 125, 28): return (0, 0, 0, 0)
    c = (40, 200, 64, 255)
    # Two opposite placement corners, with a compact window at their center.
    for box in [(25, 25, 57, 33), (25, 25, 33, 57),
                (71, 95, 103, 103), (95, 71, 103, 103)]:
        if rounded(x, y, *box, 4): c = (16, 41, 21, 255)
    if rounded(x, y, 42, 42, 86, 86, 7): c = (246, 255, 247, 255)
    if rounded(x, y, 48, 51, 80, 55, 2): c = (16, 41, 21, 255)
    return c

def chunk(kind, data):
    return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)

for size in (16, 32, 48, 128):
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)
        for x in range(size):
            samples = [color((x + (a + .5) / 4) * 128 / size, (y + (b + .5) / 4) * 128 / size) for a in range(4) for b in range(4)]
            alpha = sum(c[3] for c in samples)
            # Store straight-alpha color to avoid dark fringes at small icon sizes.
            pixels.extend([round(sum(c[k] * c[3] for c in samples) / alpha) if alpha else 0 for k in range(3)] + [round(alpha / 16)])
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')
    (ROOT / 'icons' / f'icon{size}.png').write_bytes(png)

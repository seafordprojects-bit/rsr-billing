# Crop + downsample a PNG with no image library available.
import zlib, struct, base64, sys

def load(fn):
    d = open(fn, 'rb').read(); pos = 8; idat = b''; w = h = 0
    while pos < len(d):
        ln = struct.unpack('>I', d[pos:pos+4])[0]
        typ = d[pos+4:pos+8]; body = d[pos+8:pos+8+ln]
        if typ == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', body[:10])
            assert bd == 8 and ct == 2, (bd, ct)
        elif typ == b'IDAT': idat += body
        pos += 12 + ln
    raw = zlib.decompress(idat); stride = w*3
    out = bytearray(w*h*3); prev = bytearray(stride); p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p+stride]); p += stride
        if f:
            for i in range(stride):
                a = line[i-3] if i >= 3 else 0
                b = prev[i]
                c = prev[i-3] if i >= 3 else 0
                if f == 1:   line[i] = (line[i]+a) & 255
                elif f == 2: line[i] = (line[i]+b) & 255
                elif f == 3: line[i] = (line[i]+(a+b)//2) & 255
                else:
                    pp = a+b-c; pa, pb, pc = abs(pp-a), abs(pp-b), abs(pp-c)
                    pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                    line[i] = (line[i]+pr) & 255
        out[y*stride:(y+1)*stride] = line; prev = line
    return w, h, bytes(out)

def glyph_bbox(w, h, px, light=200):
    """bounding box of the white monogram inside the red field"""
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        row = y*w*3
        for x in range(w):
            i = row + x*3
            if px[i] > light and px[i+1] > light and px[i+2] > light:
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    return x0, y0, x1, y1

def crop_square(w, h, px, box, pad_frac):
    x0, y0, x1, y1 = box
    gw, gh = x1-x0+1, y1-y0+1
    side = max(gw, gh)
    pad = int(side * pad_frac)
    side += pad*2
    cx, cy = (x0+x1)//2, (y0+y1)//2
    sx, sy = cx - side//2, cy - side//2
    # keep the crop inside the source
    sx = max(0, min(sx, w-side)); sy = max(0, min(sy, h-side))
    side = min(side, w-sx, h-sy)
    return sx, sy, side

def resample(w, h, px, sx, sy, side, out_n):
    """box average — the source is flat colour, so this stays crisp"""
    out = bytearray(out_n*out_n*3)
    for oy in range(out_n):
        y0 = sy + oy*side//out_n
        y1 = max(y0+1, sy + (oy+1)*side//out_n)
        for ox in range(out_n):
            x0 = sx + ox*side//out_n
            x1 = max(x0+1, sx + (ox+1)*side//out_n)
            r = g = b = n = 0
            for yy in range(y0, y1):
                base = yy*w*3
                for xx in range(x0, x1):
                    i = base + xx*3
                    r += px[i]; g += px[i+1]; b += px[i+2]; n += 1
            o = (oy*out_n+ox)*3
            out[o] = r//n; out[o+1] = g//n; out[o+2] = b//n
    return bytes(out)

def crop_rect(w, h, px, box, pad_frac):
    """crop to the glyph's own aspect, not forced square"""
    x0, y0, x1, y1 = box
    gw, gh = x1-x0+1, y1-y0+1
    pad = int(max(gw, gh) * pad_frac)
    sx, sy = max(0, x0-pad), max(0, y0-pad)
    ex, ey = min(w, x1+1+pad), min(h, y1+1+pad)
    return sx, sy, ex-sx, ey-sy

def dark_bbox(w, h, px, dark=100):
    """bounding box of a dark glyph on a light field"""
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        row = y*w*3
        for x in range(w):
            i = row + x*3
            if px[i] < dark and px[i+1] < dark and px[i+2] < dark:
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    return x0, y0, x1, y1

def resample_rect(w, h, px, sx, sy, cw, ch, ow, oh):
    out = bytearray(ow*oh*3)
    for oy in range(oh):
        y0 = sy + oy*ch//oh
        y1 = max(y0+1, sy + (oy+1)*ch//oh)
        for ox in range(ow):
            x0 = sx + ox*cw//ow
            x1 = max(x0+1, sx + (ox+1)*cw//ow)
            r = g = b = n = 0
            for yy in range(y0, y1):
                base = yy*w*3
                for xx in range(x0, x1):
                    i = base + xx*3
                    r += px[i]; g += px[i+1]; b += px[i+2]; n += 1
            o = (oy*ow+ox)*3
            out[o] = r//n; out[o+1] = g//n; out[o+2] = b//n
    return bytes(out)

def to_ink(px):
    """black ink with alpha taken from darkness, so the field drops out.
    Prints as solid black on any paper and needs no background graphics."""
    n = len(px)//3
    out = bytearray(n*4)
    for i in range(n):
        lum = (px[i*3]*299 + px[i*3+1]*587 + px[i*3+2]*114)//1000
        out[i*4] = out[i*4+1] = out[i*4+2] = 0
        out[i*4+3] = 255 - lum
    return bytes(out)

def encode_rgba(w, h, px):
    stride = w*4
    best = None
    for f in (0, 1, 2, 3, 4):
        raw = bytearray(); prev = bytearray(stride)
        for y in range(h):
            line = px[y*stride:(y+1)*stride]
            enc = bytearray(stride)
            for i in range(stride):
                a = line[i-4] if i >= 4 else 0
                b = prev[i]
                c = prev[i-4] if i >= 4 else 0
                if f == 0:   enc[i] = line[i]
                elif f == 1: enc[i] = (line[i]-a) & 255
                elif f == 2: enc[i] = (line[i]-b) & 255
                elif f == 3: enc[i] = (line[i]-(a+b)//2) & 255
                else:
                    pp = a+b-c; pa, pb, pc = abs(pp-a), abs(pp-b), abs(pp-c)
                    pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                    enc[i] = (line[i]-pr) & 255
            raw.append(f); raw += enc; prev = line
        comp = zlib.compress(bytes(raw), 9)
        if best is None or len(comp) < len(best): best = comp
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t+d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', best) + chunk(b'IEND', b''))

def encode(n, px):
    stride = n*3
    best = None
    for f in (0, 1, 2, 3, 4):
        raw = bytearray(); prev = bytearray(stride)
        for y in range(n):
            line = px[y*stride:(y+1)*stride]
            enc = bytearray(stride)
            for i in range(stride):
                a = line[i-3] if i >= 3 else 0
                b = prev[i]
                c = prev[i-3] if i >= 3 else 0
                if f == 0:   enc[i] = line[i]
                elif f == 1: enc[i] = (line[i]-a) & 255
                elif f == 2: enc[i] = (line[i]-b) & 255
                elif f == 3: enc[i] = (line[i]-(a+b)//2) & 255
                else:
                    pp = a+b-c; pa, pb, pc = abs(pp-a), abs(pp-b), abs(pp-c)
                    pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                    enc[i] = (line[i]-pr) & 255
            raw.append(f); raw += enc; prev = line
        comp = zlib.compress(bytes(raw), 9)
        if best is None or len(comp) < len(best): best = comp
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t+d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', n, n, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', best) + chunk(b'IEND', b''))

if __name__ == '__main__':
    # ink mode: python mkicon.py src --ink <height> <pad> out.png
    if sys.argv[2] == '--ink':
        src, oh, pad, dst = sys.argv[1], int(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
        w, h, px = load(src)
        box = dark_bbox(w, h, px)
        sx, sy, cw, ch = crop_rect(w, h, px, box, pad)
        ow = max(1, round(oh * cw / ch))
        print(f'  source {w}x{h}, glyph {box}, crop {cw}x{ch} -> {ow}x{oh} ink')
        small = resample_rect(w, h, px, sx, sy, cw, ch, ow, oh)
        png = encode_rgba(ow, oh, to_ink(small))
        b64 = base64.b64encode(png).decode()
        open(dst, 'wb').write(png)
        print(f'  png {len(png)} bytes, base64 {len(b64)} chars ({len(b64)/1024:.1f} KB)')
        raise SystemExit

    src, out_n, pad = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
    w, h, px = load(src)
    box = glyph_bbox(w, h, px)
    sx, sy, side = crop_square(w, h, px, box, pad)
    print(f'  source {w}x{h}, glyph {box}, crop {side}x{side} at ({sx},{sy}) -> {out_n}x{out_n}')
    small = resample(w, h, px, sx, sy, side, out_n)
    png = encode(out_n, small)
    b64 = base64.b64encode(png).decode()
    open(sys.argv[4], 'wb').write(png)
    print(f'  png {len(png)} bytes, base64 {len(b64)} chars ({len(b64)/1024:.1f} KB)')

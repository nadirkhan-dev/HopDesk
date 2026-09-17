"""Writes a WinPR SAM line (user:::NT-hash:::) for FreeRDP's NLA server.

MD4 is implemented here because OpenSSL 3 no longer provides it to hashlib.
Test credentials only.
"""
import struct
import sys


def md4(data: bytes) -> bytes:
    def rol(v, s):
        v &= 0xFFFFFFFF
        return ((v << s) | (v >> (32 - s))) & 0xFFFFFFFF

    msg = bytearray(data) + b'\x80'
    while len(msg) % 64 != 56:
        msg.append(0)
    msg += struct.pack('<Q', len(data) * 8)
    a, b, c, d = 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476
    rounds = [
        (lambda x, y, z: (x & y) | (~x & z), 0, [(i, s) for i, s in zip(range(16), [3, 7, 11, 19] * 4)]),
        (lambda x, y, z: (x & y) | (x & z) | (y & z), 0x5A827999,
         [(i, s) for i, s in zip([0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15], [3, 5, 9, 13] * 4)]),
        (lambda x, y, z: x ^ y ^ z, 0x6ED9EBA1,
         [(i, s) for i, s in zip([0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15], [3, 9, 11, 15] * 4)]),
    ]
    for off in range(0, len(msg), 64):
        x = struct.unpack('<16I', msg[off:off + 64])
        aa, bb, cc, dd = a, b, c, d
        for f, k, order in rounds:
            for n, (i, s) in enumerate(order):
                if n % 4 == 0:
                    a = rol(a + f(b, c, d) + x[i] + k, s)
                elif n % 4 == 1:
                    d = rol(d + f(a, b, c) + x[i] + k, s)
                elif n % 4 == 2:
                    c = rol(c + f(d, a, b) + x[i] + k, s)
                else:
                    b = rol(b + f(c, d, a) + x[i] + k, s)
        a, b, c, d = [(p + q) & 0xFFFFFFFF for p, q in ((a, aa), (b, bb), (c, cc), (d, dd))]
    return struct.pack('<4I', a, b, c, d)


assert md4(b'').hex() == '31d6cfe0d16ae931b73c59d7e0c089c0'
assert md4(b'abc').hex() == 'a448017aaf21d8525fc10ae87aa6729d'
user, password = sys.argv[1], sys.argv[2]
print(f'{user}:::{md4(password.encode("utf-16-le")).hex()}:::')

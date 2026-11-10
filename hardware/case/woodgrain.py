"""Procedural wood grain as a height field, for displacing a printed surface.

The model is a flat-sawn board cut from a log whose axis runs along +y.
Growth rings are the distance from the log axis. The distance from the cut
plane to the axis changes slowly along the board, so the rings make the
arches ("cathedrals") of real veneer at the center and run straight at the
edges. Noise warps the rings and changes their width, fine streaks along the
grain give the fibers, and knots bend the rings around them.

wood(u, y) takes millimetres on the unwrapped surface (u across the grain,
y along it) and returns heights in [0, 1]: 1 is the surface, 0 is the full
depth. Latewood stands proud and earlywood sits low, like wire-brushed oak.
"""

import numpy as np

_PERM = np.random.default_rng(1983).permutation(256).astype(np.int64)
_PERM = np.concatenate([_PERM, _PERM])
_GRAD = np.random.default_rng(1984).uniform(-1.0, 1.0, 256)


def _fade(t):
    return t * t * t * (t * (t * 6 - 15) + 10)


def noise2(x, y, seed=0):
    """Smooth value noise in [-1, 1]."""
    x = np.asarray(x, dtype=np.float64) + 17.0 * seed
    y = np.asarray(y, dtype=np.float64) + 31.0 * seed
    xi = np.floor(x).astype(np.int64)
    yi = np.floor(y).astype(np.int64)
    xf = x - xi
    yf = y - yi
    xi &= 255
    yi &= 255

    def g(ix, iy):
        return _GRAD[_PERM[_PERM[ix & 255] + (iy & 255)]]

    u = _fade(xf)
    v = _fade(yf)
    a = g(xi, yi) + u * (g(xi + 1, yi) - g(xi, yi))
    b = g(xi, yi + 1) + u * (g(xi + 1, yi + 1) - g(xi, yi + 1))
    return a + v * (b - a)


def fbm(x, y, seed=0, octaves=4):
    total = np.zeros(np.broadcast(np.asarray(x), np.asarray(y)).shape)
    amp, freq, norm = 1.0, 1.0, 0.0
    for i in range(octaves):
        total += amp * noise2(x * freq, y * freq, seed + 7 * i)
        norm += amp
        amp *= 0.5
        freq *= 2.03
    return total / norm


def _smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def wood(u, y, center=124.0, ring_mm=3.6, knots=()):
    """Height in [0, 1] at (u, y) millimetres. See the module docstring.

    center: u of the log axis (put it in the middle of the widest face).
    ring_mm: the mean growth-ring width.
    knots: (u, y, radius_mm, strength_rings) tuples.
    """
    u = np.asarray(u, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)

    # Warp the board a little so no line is ruler-straight.
    uw = u + 5.0 * fbm(u / 45.0, y / 140.0, seed=1)

    # The cut plane's distance to the log axis drifts along the board: where it
    # comes close, the rings open up into an arch.
    depth = 30.0 + 0.32 * (y - 55.0) + 7.0 * fbm(y / 70.0, 0.37, seed=2, octaves=3)
    depth = np.maximum(depth, 4.0)
    uc = center + 14.0 * fbm(y / 260.0, 0.71, seed=3, octaves=2)
    r = np.sqrt((uw - uc) ** 2 + depth**2)

    rings = r / ring_mm
    rings += 1.1 * fbm(r / 22.0, y / 260.0, seed=4)  # uneven ring widths
    for ku, ky, rad, strength in knots:
        d2 = ((u - ku) ** 2 + ((y - ky) * 0.55) ** 2) / rad**2
        rings += strength * np.exp(-d2)

    f = rings - np.floor(rings)
    # Earlywood low, latewood high, then a short drop at the ring boundary.
    late = _smoothstep(0.12, 0.88, f) ** 1.4
    late *= 1.0 - _smoothstep(0.90, 1.0, f)

    # Fibers and pores: fine streaks that run along the grain.
    fiber = 0.5 + 0.5 * fbm(uw / 0.55, y / 14.0, seed=5, octaves=3)
    pores = _smoothstep(0.55, 0.85, 0.5 + 0.5 * noise2(uw / 0.35, y / 2.2, seed=6))

    h = 0.78 * late + 0.22 * fiber - 0.18 * pores * (1.0 - late)
    return np.clip(h, 0.0, 1.0)

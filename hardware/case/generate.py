"""Generate the Retro Cable Box case: a wood-grain cover and a body.

    python3 -m venv .venv && .venv/bin/pip install manifold3d numpy
    .venv/bin/python generate.py

Writes case-cover.stl and case-body.stl next to this file.

The case is an 80s cable box: a U-shaped cover (top and two sides) in wood
grain, and a body (floor, black faceplate, back panel) that slides into the
cover from the front. Two M2.5 screws from below hold the body in the cover.

Axes: x left to right, y front to back, z up. Millimetres.
"""

import math
import pathlib
import struct
import sys

import numpy as np
from manifold3d import CrossSection, Manifold, set_circular_segments

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from woodgrain import wood  # noqa: E402

set_circular_segments(96)
OUT = pathlib.Path(__file__).parent

# ── overall size ───────────────────────────────────────────────────────────
W, D, H = 160.0, 110.0, 44.0  # cover outside
T = 3.0  # cover wall
R = 3.0  # radius of the cover's two top edges
RAIL_W, RAIL_H = 6.0, 2.0  # inward rails at the foot of each side: the feet
CLR = 0.3  # sliding clearance
GRAIN_DEPTH = 0.45  # how deep the grain cuts into the surface
SKIN = 1.2  # thickness of the textured outer layer

# ── body ───────────────────────────────────────────────────────────────────
BASE_Z0 = RAIL_H  # the floor sits on the rails
BASE_T = 2.4
BASE_Z1 = BASE_Z0 + BASE_T
INNER_TOP = H - T - CLR  # highest point of anything inside
TIES, TIE_W = 3, 1.2  # breakaway print ties across the side port window
FACE_T = 4.0  # faceplate thickness, in front of the cover (y < 0)
BACK_T = 3.0

# ── Raspberry Pi 5 (also fits a Pi 4) ──────────────────────────────────────
PI_L, PI_W, PI_T = 85.0, 56.0, 1.6
STANDOFF = 6.0
PI_X0 = W - T - 2.5 - PI_L  # the USB and Ethernet end faces the right side
PI_Y1 = D - BACK_T - 1.5  # the HDMI and USB-C edge faces the back
PI_Z0 = BASE_Z1 + STANDOFF  # underside of the board
PI_TOP = PI_Z0 + PI_T
PI_HOLES = [(3.5, 3.5), (61.5, 3.5), (3.5, 52.5), (61.5, 52.5)]  # from the HDMI edge


def pi_xy(px, py):
    """Pi board coordinates (x along the long edge, y in from the HDMI edge)."""
    return PI_X0 + px, PI_Y1 - py


# TM1637 4-digit LED module (0.36" display): PCB 42 x 24, display 30 x 14 x 7.2.
LED_CX, LED_CZ = 42.0, 24.0
LED_WIN = (31.0, 15.0)
LED_PCB = (42.0, 24.0)
LED_DISPLAY_DEPTH = 7.2

INSERT_D = 3.6  # hole for an M2.5 heat-set insert
SCREW_D = 2.9  # clearance hole for M2.5
LOCK_X = T + RAIL_W / 2 + 0.5  # body lock screws, one each side, from below
LOCK_Y = 30.0


# ── helpers ────────────────────────────────────────────────────────────────
def box(x0, y0, z0, x1, y1, z1):
    return Manifold.cube((x1 - x0, y1 - y0, z1 - z0)).translate((x0, y0, z0))


def cyl_z(x, y, z0, z1, d):
    return Manifold.cylinder(z1 - z0, d / 2, d / 2).translate((x, y, z0))


def cyl_y(x, z, y0, y1, d):
    c = Manifold.cylinder(y1 - y0, d / 2, d / 2)  # along +z
    return c.rotate((-90, 0, 0)).translate((x, y0, z))


def slot_y(cx, cz, w, h, y0, y1):
    """A rounded slot through a wall in the xz plane (axis along y)."""
    r = min(w, h) / 2
    cs = CrossSection.square((w - 2 * r, h - 2 * r), center=True).offset(r, join_type=_ROUND)
    return cs.extrude(y1 - y0).rotate((-90, 0, 0)).translate((cx, y0, cz))


def slot_x(cy, cz, w, h, x0, x1, r=None):
    """A rounded slot through a wall in the yz plane (axis along x).

    r: the corner radius. The default rounds the ends fully.
    """
    r = min(w, h) / 2 if r is None else r
    # After the turn about y, the section's first axis is z and its second is y.
    cs = CrossSection.square((h - 2 * r, w - 2 * r), center=True).offset(r, join_type=_ROUND)
    return cs.extrude(x1 - x0).rotate((0, 90, 0)).translate((x0, cy, cz))


def slot_z(cx, cy, w, l, z0, z1):
    """A rounded slot through a horizontal plate: w along x, l along y."""
    r = min(w, l) / 2
    cs = CrossSection.square((w - 2 * r, l - 2 * r), center=True).offset(r, join_type=_ROUND)
    return cs.extrude(z1 - z0).translate((cx, cy, z0))


from manifold3d import JoinType  # noqa: E402

_ROUND = JoinType.Round


def profile(inset):
    """The cover's outside cross-section (x, z), shrunk by `inset`.

    A rectangle with two rounded top corners, run below z = 0 so that an
    inset leaves the bottom open. Extruded along y.
    """
    core = CrossSection.square((W - 2 * R, H - R + 10)).translate((R, -10))
    rounded = CrossSection.square((W - 2 * R, H - 2 * R)).translate((R, R)).offset(R, join_type=_ROUND)
    bottom = CrossSection.square((W, H - R + 10)).translate((0, -10))
    shape = core + rounded + bottom
    return shape.offset(-inset, join_type=_ROUND) if inset else shape


def extrude_y(cs, y0, y1):
    """Extrude an xz cross-section along +y from y0 to y1."""
    # CrossSection is (x, y) and extrudes along +z; map its y to z, z to y.
    m = cs.extrude(y1 - y0)
    m = m.transform(np.array([[1, 0, 0, 0], [0, 0, 1, y0], [0, 1, 0, 0]], dtype=np.float64))
    return m


ABOVE = CrossSection.square((W + 20, H + 20)).translate((-10, 0))  # z >= 0


# ── the outside surface: where each point is and which way it faces ────────
ARC = math.pi * R / 2
U_LEFT_TOP = H - R
U_TOP_START = U_LEFT_TOP + ARC
U_TOP_END = U_TOP_START + (W - 2 * R)
U_TOTAL = U_TOP_END + ARC + (H - R)


def outside_frame(x, z):
    """For points on the outside surface: unwrapped u, outward normal (nx, nz),
    and the distance from the surface (0 on it)."""
    u = np.zeros_like(x)
    nx = np.zeros_like(x)
    nz = np.zeros_like(x)
    dist = np.full_like(x, 1e9)

    low = z <= H - R
    left = low & (x < W / 2)
    right = low & (x >= W / 2)
    u[left], nx[left], dist[left] = z[left], -1.0, np.abs(x[left])
    u[right], nx[right], dist[right] = U_TOTAL - z[right], 1.0, np.abs(W - x[right])

    top = (~low) & (x >= R) & (x <= W - R)
    u[top], nz[top], dist[top] = U_TOP_START + (x[top] - R), 1.0, np.abs(H - z[top])

    for side, cx in ((-1, R), (1, W - R)):
        m = (~low) & ((x < R) if side < 0 else (x > W - R))
        dx, dz = x[m] - cx, z[m] - (H - R)
        rr = np.hypot(dx, dz)
        dist[m] = np.abs(rr - R)
        nx[m], nz[m] = dx / np.maximum(rr, 1e-9), dz / np.maximum(rr, 1e-9)
        ang = np.arctan2(dz, np.abs(dx))  # 0 at the side, pi/2 at the top
        u[m] = U_LEFT_TOP + R * ang if side < 0 else U_TOP_END + R * (math.pi / 2 - ang)
    return u, nx, nz, dist


# Two knots: one on the top, one low on the left side.
KNOTS = ((U_TOP_START + 118.0, 74.0, 3.4, 1.5), (26.0, 28.0, 3.0, 1.2))


def grain_warp(verts):
    """Push the outside-surface vertices in by the wood-grain depth."""
    v = np.array(verts, dtype=np.float64)
    x, y, z = v[:, 0], v[:, 1], v[:, 2]
    u, nx, nz, dist = outside_frame(x, z)
    on = dist < 0.02
    h = wood(u[on], y[on], center=U_TOTAL / 2, knots=KNOTS)
    cut = (1.0 - h) * GRAIN_DEPTH
    v[on, 0] -= nx[on] * cut
    v[on, 2] -= nz[on] * cut
    return v


# ── cover ──────────────────────────────────────────────────────────────────
def cover():
    # The plain shell, kept back from the outside so the textured skin forms it.
    shell = (profile(0.8) - profile(T)) ^ ABOVE
    shell = extrude_y(shell, 0, D)

    # The rails along the foot of each side: the feet, and what the floor sits on.
    rails = box(T - 0.5, 0, 0, T + RAIL_W, D, RAIL_H) + box(W - T - RAIL_W, 0, 0, W - T + 0.5, D, RAIL_H)

    # The textured outer skin. Refine it more finely across the grain (u)
    # than along it (y), then displace it.
    skin = extrude_y((profile(0) - profile(SKIN)) ^ ABOVE, 0, D)
    skin = skin.scale((1.0, 0.5, 1.0)).refine_to_length(0.32).scale((1.0, 2.0, 1.0))
    skin = skin.warp_batch(grain_warp)

    c = Manifold.batch_boolean([shell, rails, skin], _ADD)

    cuts = []
    # Window on the right side for the Pi's USB and Ethernet ports. Small
    # corner radius: fully round ends would block the corners of the outer
    # ports (the USB stack is 16 mm tall and runs close to the board edge).
    y0, y1 = pi_xy(0, PI_W + 1.0)[1], pi_xy(0, -1.0)[1]
    cuts.append(slot_x((y0 + y1) / 2, PI_TOP + 8.6, y1 - y0, 19.5, W - T - 1, W + 1, r=2.5).refine_to_length(50))
    # Vents in the top, over the Pi's fan. Long along y so they print as
    # narrow bridges when the cover stands on its front edge.
    for i in range(9):
        cx = PI_X0 + 16.0 + i * 5.0
        cuts.append(slot_z(cx, PI_Y1 - 30.0, 2.4, 40.0, H - T - 1, H + 1))
    # Lock screw holes up through each rail.
    for lx in (LOCK_X, W - LOCK_X):
        cuts.append(cyl_z(lx, LOCK_Y, -1, RAIL_H + 1, SCREW_D))
        cuts.append(cyl_z(lx, LOCK_Y, -1, 0.8, 5.2))  # a shallow counterbore for the head
    c = c - Manifold.batch_boolean(cuts, _ADD)

    # Print ties across the port window. Without them, the strip of wall under
    # the window is a free fin 58 mm tall while the cover prints on its front
    # edge; it wobbles, the nozzle knocks it, and the print fails. The ties sit
    # on the inner part of the wall so the cut marks do not show. Cut them out
    # with flush cutters after printing.
    zc = PI_TOP + 8.6
    ties = [box(W - T, ty - TIE_W / 2, zc - 9.75 - 0.5, W - 1.2, ty + TIE_W / 2, zc + 9.75 + 0.5)
            for ty in np.linspace(y0, y1, TIES + 2)[1:-1]]
    return Manifold.batch_boolean([c, *ties], _ADD)


# ── body ───────────────────────────────────────────────────────────────────
def body():
    parts = []
    # Floor, riding on the rails inside the cover.
    floor = box(T + CLR, 0, BASE_Z0, W - T - CLR, D, BASE_Z1)
    parts.append(floor)

    # Faceplate, in front of the cover, with the cover's rounded top corners.
    face_cs = profile(0) ^ CrossSection.square((W + 20, H - BASE_Z0)).translate((-10, BASE_Z0))
    parts.append(extrude_y(face_cs, -FACE_T, 0.0))

    # Back panel, inside the cover.
    parts.append(box(T + CLR, D - BACK_T, BASE_Z1 - 0.01, W - T - CLR, D, INNER_TOP))

    # Pi standoffs.
    for hx, hy in PI_HOLES:
        x, y = pi_xy(hx, hy)
        parts.append(cyl_z(x, y, BASE_Z1 - 0.01, PI_Z0, 6.4))

    # Lock bosses for the two screws from below.
    for lx in (LOCK_X, W - LOCK_X):
        boss = cyl_z(lx, LOCK_Y, BASE_Z1 - 0.01, BASE_Z1 + 6.0, 8.0)
        parts.append(boss ^ box(T + CLR, 0, 0, W - T - CLR, D, H))

    # Holder for the LED module: two slotted posts and a shelf.
    pcb_w, pcb_h = LED_PCB
    py0, py1 = LED_DISPLAY_DEPTH - 0.2, LED_DISPLAY_DEPTH + 1.6 + 0.4
    for side in (-1, 1):
        edge = LED_CX + side * (pcb_w / 2 + 0.3)
        post = box(min(edge, edge + side * 3.0) - (2.0 if side < 0 else 0), 0, BASE_Z1 - 0.01,
                   max(edge, edge + side * 3.0) + (2.0 if side > 0 else 0), py1 + 2.5, LED_CZ + pcb_h / 2 + 2)
        groove = box(min(edge, edge - side * 3) - 0.01, py0, LED_CZ - pcb_h / 2,
                     max(edge, edge - side * 3) + 0.01, py1, H)
        parts.append(post - groove)
    parts.append(box(LED_CX - pcb_w / 2, py0 - 0.5, BASE_Z1 - 0.01, LED_CX + pcb_w / 2, py1 + 2.5,
                     LED_CZ - pcb_h / 2 - 0.2))

    b = Manifold.batch_boolean(parts, _ADD)

    cuts = []
    # Floor vents under the Pi.
    for i in range(10):
        cuts.append(slot_z(PI_X0 + 12 + i * 6.0, PI_Y1 - PI_W / 2, 2.6, 36, BASE_Z0 - 1, BASE_Z1 + 1))
    # Pi standoff holes for M2.5 heat-set inserts.
    for hx, hy in PI_HOLES:
        x, y = pi_xy(hx, hy)
        cuts.append(cyl_z(x, y, PI_Z0 - 5.0, PI_Z0 + 1, INSERT_D))
    # Lock boss holes, from below, for heat-set inserts.
    for lx in (LOCK_X, W - LOCK_X):
        cuts.append(cyl_z(lx, LOCK_Y, BASE_Z0 - 1, BASE_Z1 + 5.0, INSERT_D))
    # Back panel: USB-C, and one slot for both micro-HDMI ports.
    bz = PI_TOP + 1.6
    usbc_x = pi_xy(11.2, 0)[0]
    hdmi0_x, hdmi1_x = pi_xy(25.8, 0)[0], pi_xy(39.2, 0)[0]
    cuts.append(slot_y(usbc_x, bz, 12.5, 7.5, D - BACK_T - 1, D + 1))
    cuts.append(slot_y((hdmi0_x + hdmi1_x) / 2, bz, hdmi1_x - hdmi0_x + 13.0, 8.5, D - BACK_T - 1, D + 1))
    # Faceplate: the LED window, with a shallow pocket in front for a red filter.
    cuts.append(box(LED_CX - LED_WIN[0] / 2, -FACE_T - 1, LED_CZ - LED_WIN[1] / 2,
                    LED_CX + LED_WIN[0] / 2, 1, LED_CZ + LED_WIN[1] / 2))
    cuts.append(slot_y(LED_CX, LED_CZ, LED_WIN[0] + 8, LED_WIN[1] + 8, -FACE_T - 1, -FACE_T + 1.0))
    # Faceplate: ribbed panel on the right, like the old boxes.
    for i in range(7):
        z = 15.0 + i * 3.0
        cuts.append(box(92.0, -FACE_T - 1, z, W - 12.0, -FACE_T + 0.7, z + 1.2))
    return b - Manifold.batch_boolean(cuts, _ADD)


from manifold3d import OpType  # noqa: E402

_ADD = OpType.Add


# ── output ─────────────────────────────────────────────────────────────────
def write_stl(m, path, name):
    mesh = m.to_mesh()
    v = np.asarray(mesh.vert_properties, dtype=np.float32)[:, :3]
    t = np.asarray(mesh.tri_verts, dtype=np.int64)
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    n = np.cross(b - a, c - a)
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    rec = np.zeros(len(t), dtype=[("n", "<f4", 3), ("a", "<f4", 3), ("b", "<f4", 3), ("c", "<f4", 3), ("x", "<u2")])
    rec["n"], rec["a"], rec["b"], rec["c"] = n, a, b, c
    with open(path, "wb") as f:
        f.write(name.encode()[:80].ljust(80, b" "))
        f.write(struct.pack("<I", len(t)))
        f.write(rec.tobytes())
    lo, hi = v.min(0), v.max(0)
    print(f"{path.name}: {len(t):,} triangles, {path.stat().st_size / 1e6:.1f} MB, "
          f"size {hi[0]-lo[0]:.1f} x {hi[1]-lo[1]:.1f} x {hi[2]-lo[2]:.1f} mm, "
          f"genus {m.genus()}, status {m.status()}")


if __name__ == "__main__":
    which = sys.argv[1:] or ["cover", "body"]
    if "body" in which:
        write_stl(body(), OUT / "case-body.stl", "Retro Cable Box body")
    if "cover" in which:
        # Stand the cover on its front edge to print: every face is a wall.
        write_stl(cover(), OUT / "case-cover.stl", "Retro Cable Box wood-grain cover")

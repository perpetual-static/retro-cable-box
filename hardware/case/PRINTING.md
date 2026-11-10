# Printing the case

The case has two parts. Both come from `generate.py` (see below).

| Part | File | Material | Orientation |
| --- | --- | --- | --- |
| Wood-grain cover | `case-cover.stl` | Wood-fill PLA or brown PLA | Stand it on its front edge |
| Body (floor, faceplate, back panel) | `case-body.stl` | Black PLA or PETG | Floor down, as exported |

## The cover

- Stand the cover on its front edge. Then the top and both sides are walls,
  and the grain prints at full nozzle detail. Do not print it flat.
- Use no supports. The vents and the port window bridge less than 20 mm.
- Use 0.16 mm layers, 3 walls, and turn off "fuzzy skin" and ironing.
- The grain is 0.45 mm deep. A wood-fill filament with a light sanding and an
  oil stain shows the grain best.

## The body

- Print with the floor on the bed. Use no supports.
- Press six M2.5 heat-set inserts: four in the Pi standoffs (from above), and
  two in the lock bosses (from below, through the floor).

## Assembly

1. Screw the Pi to the standoffs with four M2.5 x 6 screws. The USB and
   Ethernet end faces right, and the HDMI edge faces the back.
2. Slide the TM1637 LED module down into the two slotted posts behind the
   faceplate window, with the display against the faceplate. Modules differ a
   little: if yours is loose, use a drop of hot glue.
3. Optional: cut a 39 x 23 mm piece of red acrylic and glue it in the pocket
   around the window.
4. Slide the body into the cover from the front until the faceplate touches
   the cover.
5. Put two M2.5 x 6 screws up through the feet into the lock bosses.

The microSD card is under the Pi. Remove the two lock screws and slide the
body out to change it.

## Change the design

```sh
python3 -m venv .venv && .venv/bin/pip install manifold3d numpy
.venv/bin/python generate.py          # both parts
.venv/bin/python generate.py cover    # one part
```

The sizes are at the top of `generate.py`. The grain is in `woodgrain.py`:
change `ring_mm`, the knots, or `GRAIN_DEPTH` for a different board.

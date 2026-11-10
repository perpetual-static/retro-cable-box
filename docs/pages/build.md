---
num: 3
name: BUILD
title: Build the box
slug: build
---

# Build the box

A Raspberry Pi in a 3D-printed case, connected to the TV with HDMI. The build
takes about an hour, plus the print time.

## Parts

<!-- generated:bom -->

Prices are approximate. Check them before you buy.

## Case files

![The case: a wood-grain cover over a black faceplate](assets/case.jpg)

The cover is the top and both sides, with a wood-grain surface in the model
itself, so the grain prints. The body (floor, faceplate and back panel) slides
into it from the front. Print settings and assembly are in
[PRINTING.md](https://github.com/perpetual-static/retro-cable-box/blob/main/hardware/case/PRINTING.md).

<!-- generated:case -->

## Assemble

> The first printed prototype can change these steps.

1. Print the cover and the body. See
   [PRINTING.md](https://github.com/perpetual-static/retro-cable-box/blob/main/hardware/case/PRINTING.md).
2. Put six M2.5 heat-set inserts into the body with a soldering iron: four in
   the Pi standoffs and two in the lock bosses, from below.
3. Attach the active cooler to the Pi. Connect its fan cable to the FAN port.
4. Attach the Pi to the standoffs with four M2.5 screws. The USB end faces
   right and the HDMI edge faces the back.
5. Optional: connect the LED readout (see below). Slide the module down into
   the posts behind the faceplate window.
6. Slide the body into the cover from the front. Put two M2.5 x 8 screws up
   through the feet.
7. Flash the microSD card and install the software. See
   [Set up the software](setup.html).
8. Connect the micro-HDMI cable to **HDMI 0** (the port next to USB-C) and to
   the TV. Connect the power supply last.

## Front-panel LED (optional)

A TM1637 4-digit module shows the channel number, like the readout on an old
cable box. It shows `----` before the first tune, and a flashing `88` when the
box cannot reach its own services.

| Module | Pi pin |
| --- | --- |
| CLK | GPIO 23 (pin 16) |
| DIO | GPIO 24 (pin 18) |
| VCC | 3.3 V (pin 17) |
| GND | pin 20 |

Turn it on with `sudo systemctl enable --now box-led`.

## The remote

- **TV remote over HDMI-CEC.** Turn on CEC in the TV settings. Each brand has
  its own name for it: Anynet+ (Samsung), SimpLink (LG), Bravia Sync (Sony).
  The box shows up as **RETRO CABLE**. Channel ± changes channel, the guide or
  menu button opens the guide, and the info button shows the banner.
- **FLIRC IR receiver.** For a TV without CEC, or any remote you like. Plug it
  in, then use the FLIRC app on a computer to teach it the remote. Map the
  buttons to these keys: ↑ ↓ ← →, Enter, Esc, Page Up / Page Down, 0–9, G, I,
  M, B, C, S.

> **License.** Build a box for yourself, change it, share your changes. The
> project is under the [PolyForm Noncommercial](https://github.com/perpetual-static/retro-cable-box/blob/main/LICENSE.md)
> license: selling boxes needs the author's permission.

> **Status.** The software install is tested in an arm64 Debian container.
> The kiosk display, HDMI audio, HDMI-CEC and the LED readout are not yet
> tested on real hardware.

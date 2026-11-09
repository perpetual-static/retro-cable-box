#!/usr/bin/env python3
"""
box-cec: the TV's own remote, over HDMI-CEC, as key presses for the TV app.

It registers the box as a CEC playback device named RETRO CABLE, asks to be
the active source (so the TV sends it remote buttons), then turns each
USER_CONTROL_PRESSED / RELEASED message into a key down / up on a virtual
keyboard. Holding a button holds the key, so Turbo Tunnel works.

Needs: v4l-utils (cec-ctl), python3-evdev, /dev/cec0, /dev/uinput. Runs as root.
Codes are the CEC "UI command" numbers, so the button names a TV brand uses
don't matter.
"""

import os
import re
import select
import subprocess
import sys
import time

from evdev import UInput, ecodes as e

DEVICE = os.environ.get("CEC_DEVICE", "/dev/cec0")
OSD_NAME = os.environ.get("CEC_OSD_NAME", "RETRO CABLE")[:14]
# If a TV misses the RELEASED message, let go after this long without a repeat.
STUCK_AFTER = 0.7

KEYS = {
    0x00: e.KEY_ENTER,      # select / OK
    0x01: e.KEY_UP,
    0x02: e.KEY_DOWN,
    0x03: e.KEY_LEFT,
    0x04: e.KEY_RIGHT,
    0x09: e.KEY_G,          # root menu → guide
    0x0A: e.KEY_S,          # setup menu → channel 0 setup screen
    0x0D: e.KEY_ESC,        # exit / back
    0x2B: e.KEY_ENTER,      # enter
    0x30: e.KEY_PAGEUP,     # channel up
    0x31: e.KEY_PAGEDOWN,   # channel down
    0x35: e.KEY_I,          # display information
    0x43: e.KEY_M,          # mute
    0x53: e.KEY_G,          # electronic program guide
    0x71: e.KEY_B,          # F1 (blue) → pop-up bubbles
    0x72: e.KEY_C,          # F2 (red) → CRT mode
    0x73: e.KEY_I,          # F3 (green) → info
    0x74: e.KEY_G,          # F4 (yellow) → guide
}
for n in range(10):
    KEYS[0x20 + n] = getattr(e, f"KEY_{n}")

UI_CMD = re.compile(r"ui-cmd:.*\((0x[0-9a-fA-F]+)\)")


def log(*args):
    print("[box-cec]", *args, flush=True)


def cec(*args):
    return subprocess.run(["cec-ctl", "-d", DEVICE, *args], capture_output=True, text=True)


def physical_address():
    out = cec().stdout
    m = re.search(r"Physical Address\s*:\s*([0-9a-f.]+)", out, re.I)
    return m.group(1) if m else None


def main():
    if not os.path.exists(DEVICE):
        log(f"{DEVICE} not found; HDMI-CEC unavailable. Use a USB IR remote instead.")
        # Sleep instead of exiting so systemd doesn't restart-loop on boxes without CEC.
        while True:
            time.sleep(3600)

    cec("--playback", "--osd-name", OSD_NAME)
    pa = physical_address()
    if pa and pa != "f.f.f.f":
        cec("--to", "0", "--active-source", f"phys-addr={pa}")
        log(f"registered as playback device {OSD_NAME!r} at {pa}")
    else:
        log("no physical address yet (is the TV on?); listening anyway")

    keys = sorted(set(KEYS.values()))
    ui = UInput({e.EV_KEY: keys}, name="box-cec-remote")
    # Kernel auto-repeat while a key is held, like a real keyboard.
    ui.write(e.EV_REP, e.REP_DELAY, 400)
    ui.write(e.EV_REP, e.REP_PERIOD, 120)

    mon = subprocess.Popen(["cec-ctl", "-d", DEVICE, "--monitor"], stdout=subprocess.PIPE, text=True, bufsize=1)
    held = None
    last = 0.0
    pending = None  # "pressed" or "released", waiting for its ui-cmd line

    def release():
        nonlocal held
        if held is not None:
            ui.write(e.EV_KEY, held, 0)
            ui.syn()
            held = None

    while True:
        ready, _, _ = select.select([mon.stdout], [], [], 0.2)
        if held is not None and time.monotonic() - last > STUCK_AFTER:
            release()
        if not ready:
            continue
        line = mon.stdout.readline()
        if not line:
            log("cec-ctl exited")
            sys.exit(1)
        if "USER_CONTROL_PRESSED" in line:
            pending = "pressed"
            continue
        if "USER_CONTROL_RELEASED" in line:
            release()
            pending = None
            continue
        m = UI_CMD.search(line)
        if pending == "pressed" and m:
            pending = None
            key = KEYS.get(int(m.group(1), 16))
            last = time.monotonic()
            if key is None or key == held:
                continue  # unknown button, or a repeat of the held one
            release()
            ui.write(e.EV_KEY, key, 1)
            ui.syn()
            held = key


if __name__ == "__main__":
    main()

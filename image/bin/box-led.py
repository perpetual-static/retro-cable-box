#!/usr/bin/env python3
"""
box-led: the cable-box channel readout on the front panel.

Drives a TM1637 4-digit 7-segment module over two GPIO pins and shows the
channel the TV is on (from /api/tuned). Shows "----" until the TV tunes, and
" 88 " flashes like a VCR clock when the API can't be reached.

Wiring (BCM numbers, change with LED_CLK / LED_DIO):
  CLK → GPIO 23 (pin 16)   DIO → GPIO 24 (pin 18)   VCC → 3.3 V (pin 17)   GND → pin 20

Needs: python3-lgpio. Runs as root.
"""

import json
import os
import time
import urllib.request

import lgpio

CLK = int(os.environ.get("LED_CLK", 23))
DIO = int(os.environ.get("LED_DIO", 24))
BRIGHTNESS = int(os.environ.get("LED_BRIGHTNESS", 4))  # 0–7
API = f"http://127.0.0.1:{os.environ.get('API_PORT', 8760)}/api/tuned"

DIGITS = [0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F]
DASH = 0x40
BLANK = 0x00
HALF = 0.00005  # 50 µs per half clock: slow and safe


class TM1637:
    def __init__(self, chip, clk, dio):
        self.h, self.clk, self.dio = chip, clk, dio
        lgpio.gpio_claim_output(self.h, clk, 1)
        lgpio.gpio_claim_output(self.h, dio, 1)

    def _w(self, pin, v):
        lgpio.gpio_write(self.h, pin, v)
        time.sleep(HALF)

    def _start(self):
        self._w(self.dio, 1)
        self._w(self.clk, 1)
        self._w(self.dio, 0)
        self._w(self.clk, 0)

    def _stop(self):
        self._w(self.clk, 0)
        self._w(self.dio, 0)
        self._w(self.clk, 1)
        self._w(self.dio, 1)

    def _byte(self, b):
        for i in range(8):
            self._w(self.dio, (b >> i) & 1)
            self._w(self.clk, 1)
            self._w(self.clk, 0)
        # ACK clock: release DIO and let the chip pull it low; we don't check it.
        lgpio.gpio_claim_input(self.h, self.dio)
        self._w(self.clk, 1)
        self._w(self.clk, 0)
        lgpio.gpio_claim_output(self.h, self.dio, 0)

    def show(self, segments, brightness=BRIGHTNESS):
        self._start()
        self._byte(0x40)  # write data, auto-increment address
        self._stop()
        self._start()
        self._byte(0xC0)  # start at digit 0
        for s in segments:
            self._byte(s)
        self._stop()
        self._start()
        self._byte(0x88 | (brightness & 7))  # display on
        self._stop()


def render(num):
    """Channel number → 4 segments, right-aligned with a leading blank: ' 03 ' style."""
    text = f"{num:02d}"[-3:]
    cells = [BLANK] * (4 - len(text) - (1 if len(text) < 3 else 0)) + [DIGITS[int(c)] for c in text]
    return (cells + [BLANK] * 4)[:4]


def main():
    chip = lgpio.gpiochip_open(int(os.environ.get("LED_GPIOCHIP", 0)))
    led = TM1637(chip, CLK, DIO)
    shown = None
    tick = 0
    while True:
        try:
            with urllib.request.urlopen(API, timeout=2) as r:
                num = json.load(r).get("num")
            frame = render(num) if isinstance(num, int) else [DASH] * 4
        except Exception:
            tick += 1
            frame = [BLANK, DIGITS[8], DIGITS[8], BLANK] if tick % 2 else [BLANK] * 4
        if frame != shown:
            led.show(frame)
            shown = frame
        time.sleep(0.5)


if __name__ == "__main__":
    main()

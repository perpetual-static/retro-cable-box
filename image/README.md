# Building a box

How to turn a Raspberry Pi into a Retro Cable Box. For the parts, see the
parts list in the project notes (Pi 5, active cooler, 27 W supply, A2 microSD,
**micro**-HDMI cable, FLIRC USB IR receiver).

> **Status.** `install.sh` is tested in an arm64 Debian container
> (`./image/test-in-container.sh`). That covers packages, Node, the Temporal
> CLI, the build, the services, the API, MCP and backups. The kiosk display,
> HDMI audio, HDMI-CEC and the LED readout have **not** been tested on real
> hardware yet. Expect to adjust them on the first prototype.

## 1. Flash the card

1. Open [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
2. Choose **Raspberry Pi OS Lite (64-bit)**.
3. Open the settings (the gear, or Ctrl-Shift-X) and set these:
   - **Hostname:** `retrocable`. The box is then `retrocable.local`.
   - **Username:** `box`, with a password of your choice.
   - **Wi-Fi:** your network and your country.
   - **Time zone:** yours. The guide and the 3:30 am health check use it.
   - **SSH:** on, with your public key.
4. Write the card. Put it in the Pi, connect it to the TV with HDMI 0 (the port
   next to USB-C), and power it on.

## 2. Install

From your laptop:

```sh
ssh box@retrocable.local
curl -fsSL https://raw.githubusercontent.com/perpetual-static/retro-cable-box/main/image/install.sh | sudo bash
```

The install takes about 10 minutes on a Pi 5 and does these things:

- It installs Chromium, cage, ffmpeg, v4l-utils, Node 22, pnpm and the
  Temporal CLI.
- It puts the app in `/opt/retro-cable-box` and the data in `/var/lib/box`.
- It writes `/etc/box/box.env` with a new MCP token.
- It enables the services. The TV takes over tty1.

When the install is done, the TV shows the starter lineup. Ingest needs about
a minute on the first boot.

## 3. Connect your agent

On the TV, type **0** (or press the setup button on the remote). Channel 0
shows the MCP address, a QR code and the token. Any MCP client works: give it
the address and send the token as `Authorization: Bearer <token>`. For
example, Claude Code on your laptop:

```sh
TOKEN=$(ssh box@retrocable.local sudo grep MCP_TOKEN= /etc/box/box.env | cut -d= -f2)
claude mcp add --transport http retro-cable-box http://retrocable.local:8750/mcp \
  --header "Authorization: Bearer $TOKEN"
```

An agent that runs in the cloud (for example, a claude.ai connector) must
reach the box from the internet. See the docs site, "Connect your agent", for
the secure ways to do that.

## 4. The remote

- **TV remote over HDMI-CEC.** Turn on CEC in the TV settings. Each brand has
  its own name for it: Anynet+ (Samsung), SimpLink (LG), Bravia Sync (Sony).
  `box-cec` makes the box show up as **RETRO CABLE** and turns the buttons
  into keys. Channel ± changes channel, the guide or menu button opens the
  guide, the info button shows the banner, and the color buttons toggle pop-ups
  (blue) and CRT mode (red).
- **FLIRC IR receiver.** Plug it in. On a laptop, use the FLIRC app to teach it
  any remote. Map the buttons to these keys: ↑ ↓ ← →, Enter, Esc, Page Up /
  Page Down, 0–9, G, I, M, B, C, S. The box needs no setup for it.

## 5. Front-panel LED (optional)

Use a TM1637 4-digit module, wired like this:

| Module | Pi pin |
| --- | --- |
| CLK | GPIO 23 (pin 16) |
| DIO | GPIO 24 (pin 18) |
| VCC | 3.3 V (pin 17) |
| GND | pin 20 |

Turn it on with `sudo BOX_LED=1 box-update`, or with
`sudo systemctl enable --now box-led`. It shows the channel number. It shows
`----` before the first tune, and a flashing `88` when the API is down.

## Everyday

| Do | Command |
| --- | --- |
| Logs | `journalctl -u 'box-*' -f` |
| Restart everything | `sudo systemctl restart box.target` |
| Update to the latest main | `sudo box-update` (or `sudo box-update v0.2.0`) |
| Temporal UI | `ssh -L 8233:localhost:8233 box@retrocable.local`, then open http://localhost:8233 |
| Backups | Weekly lineup files in `/var/lib/box/backup` (Sundays at 4 am) |
| Your own media | Copy files to `/var/lib/box/media`, then ask your agent to add them as `local` sources |

## Files

```
install.sh              install or update (idempotent)
test-in-container.sh    run install.sh in arm64 Debian and check the box answers
systemd/                box.target and one unit per service (@BOX_*@ filled in by install.sh)
bin/box-kiosk           cage + Chromium kiosk on tty1
bin/box-cec.py          HDMI-CEC remote → virtual keyboard
bin/box-led.py          TM1637 channel readout
bin/box-update          pull, rebuild, restart
bin/box-backup          weekly lineup export
```

## Choices made here (see plan.md)

- **Temporal runs as the CLI dev server with a SQLite file**, not Postgres in
  Docker. It is one binary with no Docker, and it uses less memory. For one box
  and one user it is enough. This resolves plan.md open decision 4 for the
  prototype. Revisit it if the database gets slow.
- **Node services run under `tsx`** from the source. The worker uses a workflow
  bundle that is built at install time, so it does not run webpack at each boot.
- **Updates are `git` based** (`box-update`). The release and manifest updater
  in plan.md §9 is still to come.

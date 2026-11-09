---
num: 4
name: SETUP
title: Set up the software
slug: setup
---

# Set up the software

## 1. Flash the card

1. Open [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
2. Choose **Raspberry Pi OS Lite (64-bit)**.
3. Open the settings (the gear, or Ctrl-Shift-X) and set these:
   - **Hostname:** `retrocable`. The box is then `retrocable.local`.
   - **Username:** `box`, with a password of your choice.
   - **Wi-Fi:** your network and your country.
   - **Time zone:** yours. The guide and the nightly check use it.
   - **SSH:** on, with your public key.
4. Write the card. Put it in the Pi, connect the Pi to the TV, and power it on.

## 2. Install

From your computer:

```sh
ssh box@retrocable.local
curl -fsSL https://raw.githubusercontent.com/perpetual-static/retro-cable-box/main/image/install.sh | sudo bash
```

The install takes about 10 minutes on a Pi 5. It does these things:

- It installs Chromium, cage, ffmpeg, Node 22, pnpm and the Temporal CLI.
- It puts the app in `/opt/retro-cable-box` and the data in `/var/lib/box`.
- It writes `/etc/box/box.env` with a new MCP token.
- It starts the services. The TV shows the starter lineup.

The starter channels need about a minute to load on the first boot.

## 3. Channel 0

Type **0** on the remote. Channel 0 is the setup screen. It shows:

- the MCP address of the box, and a QR code for it
- the MCP token
- the pairing code, when the box has a public address

Then [connect your agent](connect.html).

## Everyday

| Do | Command |
| --- | --- |
| Logs | `journalctl -u 'box-*' -f` |
| Restart everything | `sudo systemctl restart box.target` |
| Update | `sudo box-update` (or `sudo box-update v0.2.0`) |
| Workflow UI | `ssh -L 8233:localhost:8233 box@retrocable.local`, then open http://localhost:8233 |
| Backups | Weekly lineup files in `/var/lib/box/backup` (Sundays at 4 am) |
| Your own media | Copy files to `/var/lib/box/media`, then ask your agent to add them |

## The keys

| Key | Does |
| --- | --- |
| ↑ ↓ (or Page Up / Page Down) | Channel up and down |
| Hold ↑ or ↓ | Turbo Tunnel: surf fast, land when you let go |
| 0–9 | Type a channel number |
| G or Enter | The guide (↑ ↓ select, ← → look ahead in time, Enter tune, G close) |
| I | The info banner |
| M | Mute |
| B | Pop-up trivia on and off |
| C | CRT mode (4:3, scanlines) |
| 0 or S | The setup screen |

On a phone or tablet: swipe up or down to change channel, tap for the info
banner, and hold for the guide.

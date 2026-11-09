#!/usr/bin/env bash
# Turn a fresh Raspberry Pi OS Lite (64-bit, Bookworm or later) into a Retro
# Cable Box. Safe to run again: every step checks before it acts.
#
#   curl -fsSL https://raw.githubusercontent.com/rossnelson/myvoiceismypassport/main/image/install.sh | sudo bash
#   # or, from a clone:
#   sudo ./image/install.sh
#
# Environment (all optional):
#   BOX_USER      user that owns the TV session (default: the user who ran sudo, else "box")
#   BOX_REPO      git URL (default: this repo)            BOX_REF   branch or tag (default: main)
#   BOX_DIR       install dir (default: /opt/retro-cable-box)
#   BOX_DATA      data dir: Temporal db, media, backups (default: /var/lib/box)
#   BOX_LED=1     enable the TM1637 front-panel readout service
#   SKIP_SYSTEMD=1  install files but don't enable or start services (used by the container test)

set -euo pipefail

BOX_REPO="${BOX_REPO:-https://github.com/rossnelson/myvoiceismypassport.git}"
BOX_REF="${BOX_REF:-main}"
BOX_DIR="${BOX_DIR:-/opt/retro-cable-box}"
BOX_DATA="${BOX_DATA:-/var/lib/box}"
BOX_USER="${BOX_USER:-${SUDO_USER:-box}}"
NODE_MAJOR=22

say() { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }
[[ "$(uname -m)" == "aarch64" ]] || warn "This is $(uname -m), not aarch64. The box targets 64-bit Pi OS."

# ── packages ─────────────────────────────────────────────────────────────────
say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
CHROMIUM=chromium
apt-cache show chromium >/dev/null 2>&1 || CHROMIUM=chromium-browser
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git gnupg openssl jq \
  ffmpeg v4l-utils \
  cage "$CHROMIUM" fonts-dejavu-core \
  avahi-daemon \
  python3 python3-evdev \
  alsa-utils
# GPIO for the optional LED readout (Pi OS ships python3-lgpio; plain Debian may not)
apt-get install -y -qq --no-install-recommends python3-lgpio 2>/dev/null || warn "python3-lgpio not available (LED readout disabled)"

# ── Node.js + pnpm ───────────────────────────────────────────────────────────
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt $NODE_MAJOR ]]; then
  say "Node.js $NODE_MAJOR"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" >/etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
command -v pnpm >/dev/null || { say "pnpm"; npm install -g pnpm@10 --silent; }

# ── Temporal CLI (runs the dev server with a SQLite file: one binary, no Docker) ─
if ! command -v temporal >/dev/null; then
  say "Temporal CLI"
  tmp="$(mktemp -d)"
  curl -fsSL "https://temporal.download/cli/archive/latest?platform=linux&arch=arm64" -o "$tmp/temporal.tgz"
  tar -xzf "$tmp/temporal.tgz" -C "$tmp"
  install -m 0755 "$tmp/temporal" /usr/local/bin/temporal
  rm -rf "$tmp"
fi
temporal --version

# ── user + folders ───────────────────────────────────────────────────────────
say "User $BOX_USER and folders"
id "$BOX_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$BOX_USER"
for g in video audio render input gpio; do
  getent group "$g" >/dev/null && usermod -aG "$g" "$BOX_USER"
done
install -d -o "$BOX_USER" -g "$BOX_USER" "$BOX_DATA" "$BOX_DATA/media" "$BOX_DATA/backup"
install -d -m 0755 /etc/box

# ── the app ──────────────────────────────────────────────────────────────────
say "App in $BOX_DIR ($BOX_REF)"
if [[ -d "$BOX_DIR/.git" ]]; then
  git -C "$BOX_DIR" fetch -q origin "$BOX_REF"
  git -C "$BOX_DIR" checkout -q "$BOX_REF"
  git -C "$BOX_DIR" reset -q --hard "origin/$BOX_REF"
elif [[ -f "$(dirname "$0")/../pnpm-workspace.yaml" && "$(cd "$(dirname "$0")/.." && pwd)" != "$BOX_DIR" ]]; then
  # Running from a local checkout: copy it (the container test does this).
  install -d "$BOX_DIR"
  (cd "$(dirname "$0")/.." && tar --exclude=node_modules --exclude=.temporal --exclude=build --exclude=dist -cf - .) | tar -xf - -C "$BOX_DIR"
else
  git clone -q --branch "$BOX_REF" "$BOX_REPO" "$BOX_DIR"
fi
chown -R "$BOX_USER:$BOX_USER" "$BOX_DIR"

say "Install dependencies and build"
sudo -u "$BOX_USER" -H bash -c "cd '$BOX_DIR' && CI=1 pnpm install --frozen-lockfile --reporter=silent && pnpm --filter @box/player build >/dev/null && pnpm --filter @box/worker build"

# ── config ───────────────────────────────────────────────────────────────────
ENV_FILE=/etc/box/box.env
if [[ ! -f $ENV_FILE ]]; then
  say "Config $ENV_FILE (new MCP token)"
  cat >"$ENV_FILE" <<EOF
# Retro Cable Box settings. Services read this file; restart them after edits:
#   sudo systemctl restart box.target
NODE_ENV=production
TEMPORAL_ADDRESS=127.0.0.1:7233
TEMPORAL_NAMESPACE=box
TEMPORAL_TASK_QUEUE=box
MCP_PORT=8750
API_PORT=8760
MEDIA_ROOT=$BOX_DATA/media
BOX_DATA=$BOX_DATA
BOX_HOSTNAME=$(hostname)
BOX_VERSION=$(git -C "$BOX_DIR" describe --tags --always 2>/dev/null || echo dev)
# Required as "Authorization: Bearer <token>" on /mcp. Channel 0 on the TV shows it.
MCP_TOKEN=$(openssl rand -hex 16)
# Set when the box is reachable from the internet (Tailscale Funnel, Phase 5):
# PUBLIC_MCP_URL=https://box.tailnet-name.ts.net/mcp
TZ=$(cat /etc/timezone 2>/dev/null || echo UTC)
EOF
  chmod 0640 "$ENV_FILE"
  chgrp "$BOX_USER" "$ENV_FILE"
else
  sed -i "s/^BOX_VERSION=.*/BOX_VERSION=$(git -C "$BOX_DIR" describe --tags --always 2>/dev/null || echo dev)/" "$ENV_FILE"
fi

# ── HDMI audio: make the HDMI port ALSA's default ────────────────────────────
if [[ ! -f /etc/asound.conf ]]; then
  cat >/etc/asound.conf <<'EOF'
# Retro Cable Box: sound goes out the HDMI port next to the USB-C power port.
defaults.pcm.card vc4hdmi0
defaults.ctl.card vc4hdmi0
EOF
fi

# ── services ─────────────────────────────────────────────────────────────────
say "systemd units"
for unit in "$BOX_DIR"/image/systemd/*; do
  sed -e "s#@BOX_DIR@#$BOX_DIR#g" -e "s#@BOX_DATA@#$BOX_DATA#g" -e "s#@BOX_USER@#$BOX_USER#g" \
    -e "s#@BOX_UID@#$(id -u "$BOX_USER")#g" "$unit" >"/etc/systemd/system/$(basename "$unit")"
done
install -m 0755 "$BOX_DIR/image/bin/box-kiosk" /usr/local/bin/box-kiosk
install -m 0755 "$BOX_DIR/image/bin/box-update" /usr/local/bin/box-update
install -m 0755 "$BOX_DIR/image/bin/box-backup" /usr/local/bin/box-backup

if [[ "${SKIP_SYSTEMD:-}" == "1" ]] || ! command -v systemctl >/dev/null || [[ ! -d /run/systemd/system ]]; then
  warn "Not enabling services (no systemd here)."
else
  systemctl daemon-reload
  # Boot to the console; box-player owns tty1 instead of a login prompt.
  systemctl set-default multi-user.target
  systemctl disable --now getty@tty1.service 2>/dev/null || true
  systemctl enable avahi-daemon
  units=(box-temporal box-worker box-mcp box-api box-player box-cec box-backup.timer)
  [[ "${BOX_LED:-}" == "1" ]] && units+=(box-led)
  systemctl enable "${units[@]}" box.target
  systemctl restart box.target
fi

say "Done."
cat <<EOF

  The TV starts on the next boot (or now, if services started).
  Channel 0 on the TV shows how to connect your agent (any MCP client).

  For example, Claude Code on your laptop:
    claude mcp add --transport http retro-cable-box http://$(hostname).local:8750/mcp \\
      --header "Authorization: Bearer \$(ssh $BOX_USER@$(hostname).local sudo grep MCP_TOKEN= /etc/box/box.env | cut -d= -f2)"

  Logs:    journalctl -u 'box-*' -f
  Update:  sudo box-update
EOF

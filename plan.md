# Retro Cable Box — Project Plan

A self-contained Raspberry Pi appliance that turns any media you point it at into
a 24/7 retro cable lineup: a 90s-style channel guide, channels on a shared clock
(tune in mid-episode like real TV), and an MCP server so your AI agent can curate your
channels for you.

It is a **schedule builder, not a content library**. It ships with no third-party
sources configured. Users (or their agent) add channels pointing at their own
media, Jellyfin/Plex, public-domain archives, or any URL they choose.

> Working title only. Pick a real name before the first release; it shows up in
> the MCP server name, hostname (`<name>.local`), and systemd units.

---

## 1. Product

**The box.** Raspberry Pi in a 3D-printed retro case (wood-grain Zenith, Sony
Trinitron grey, or a cable-box black with a faux-LED channel readout). HDMI to the
TV. Boots straight into the channel guide. Controlled by the TV's own remote over
HDMI-CEC, with a cheap USB IR remote as a fallback.

**The pitch.** "Build your own cable network." Not "we picked the channels."

**What ships on the SD card**

- The guide + player UI
- The scheduler (Temporal) and worker
- The MCP server
- A starter lineup of genuinely public-domain channels (Prelinger Archives
  industrial films, PD features, NASA, old PSAs, PD cartoons) so it does
  something on first boot
- An "import lineup from URL" feature so the community can share lineups without
  us hosting or distributing any of them

**What never ships.** Any preconfigured channel pointing at copyrighted uploads,
and no Pluto TV or other service restreaming. This is the line between selling a
tool and selling a "fully loaded box." Keep it bright.

**Later.** LAN output (M3U + XMLTV) so Apple TV, phones, and other TVs in the
house can tune the same lineup via an IPTV app or Jellyfin Live TV. A native
tvOS app is a possible phase after that, not a requirement.

---

## 2. Architecture

Mirrors the trips platform: Temporal entity workflows as the source of truth,
pure reducers in a core package, an MCP server as the curation surface, a web UI
as the read surface. Everything runs on the Pi.

```
┌──────────────────────────────── Raspberry Pi ────────────────────────────────┐
│                                                                              │
│  Temporal server (Docker)  ◄──►  worker (Node, systemd)                      │
│   · channelWorkflow × N           · reducers + validators (core)             │
│   · lineupWorkflow                · activities: archive.org metadata,        │
│   · ingest / healthcheck /          ffprobe, HTTP checks, image pulls,       │
│     updater (Schedules)             local media scan                         │
│                                                                              │
│  mcp (Node, systemd)  ◄── LAN / tunnel ──  Claude (claude.ai connector)      │
│   · curation tools                                                           │
│                                                                              │
│  api (Node, systemd)  ──►  player (SvelteKit static, Chromium kiosk) ─► HDMI │
│   · /lineup.json /schedule.json      · 90s guide, <video> playback           │
│   · /playlist.m3u /guide.xml         · CEC remote input                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Control plane vs data plane.** Temporal owns *what* a channel is and *when*
things change. It does not sit in the playback path. Each channel workflow
exposes a query that returns a flattened schedule (anchor + ordered items with
durations). The API caches it and serves it as JSON; the player computes
"what's on at time T" locally with one modulo. A Pi doing 60 fps guide
animation should never block on a workflow query.

**Shared clock.** `position = (now - anchor) mod totalDuration`, then walk
cumulative durations to find the item and offset. Same formula everywhere
(player, M3U/XMLTV generator, MCP `whats_on`). Editing a channel's items
re-anchors it so the current item doesn't jump; the reducer handles that.

---

## 3. Repository layout

pnpm workspace, TypeScript throughout, Taskfile for local dev. Same shape as
`trips` so the muscle memory carries over.

```
.
├── packages/
│   └── core/                 @box/core
│       ├── types.ts          Channel, Item, Source, Lineup, Notice, BoxState
│       ├── mutations.ts      pure reducers + validators (the only place state changes)
│       ├── schedule.ts       flatten(), whatsOn(), reanchor() — shared clock math
│       ├── workflows.ts      channelWorkflow, lineupWorkflow, ingest, healthcheck, updater
│       ├── activities.ts     interfaces only (implementations live in the worker)
│       └── client.ts         Temporal client factory, namespace/task-queue constants
├── services/
│   ├── worker/               Temporal worker; activity implementations; namespace upsert on boot
│   ├── mcp/                  MCP server (streamable HTTP) — curation tools
│   └── api/                  tiny HTTP server: lineup/schedule JSON, M3U, XMLTV, notices, health
├── apps/
│   └── player/               SvelteKit static — guide + player, runs in Chromium kiosk
├── image/                    Pi image build: pi-gen config, systemd units, compose file, first-boot
├── hardware/                 case STL/STEP, BOM, assembly notes
├── lineups/                  starter public-domain lineup(s) as JSON
├── .github/workflows/        release: tag, build arm64 images → ghcr.io, attach manifest.json
├── Taskfile.yml
└── PLAN.md
```

---

## 4. Domain model (`packages/core/types.ts`)

```ts
type Source =
  | { kind: 'archive'; identifier: string; file?: string }   // archive.org item (+ optional file within it)
  | { kind: 'url'; url: string; fallbackUrl?: string }       // any direct MP4/MP3/HLS URL
  | { kind: 'local'; path: string }                          // file on the box or mounted share
  | { kind: 'jellyfin'; server: string; itemId: string }     // phase 2+
  | { kind: 'hls'; url: string };                            // live stream (user-provided)

interface Item {
  id: string;
  title: string;
  source: Source;
  durationSec: number;        // resolved by ingest (ffprobe / archive metadata)
  year?: number;
  tags?: string[];
  bubbles?: Bubble[];         // pop-up trivia, see §11
}

interface Bubble {
  atSec: number;              // offset into the item
  text: string;               // ≤ 90 chars; one fact, no spoilers
  durationSec?: number;       // default 6
}

type ChannelKind =
  | 'playlist'   // loops items on the shared clock (the normal case)
  | 'live'       // single HLS source, no schedule
  | 'card';      // generated screen: notice board, weather, clock, "please stand by"

interface Channel {
  id: string;             // slug, stable
  num: number;            // guide position
  name: string;           // uppercase, ≤ 16 chars looks right on the guide
  kind: ChannelKind;
  blurb?: string;
  category?: string;
  anchorEpoch: number;    // shared-clock origin, seconds
  items: Item[];          // playlist channels
  rules?: ScheduleRules;  // optional: shuffle seed, dayparting, ad-break inserts
}

interface Lineup { version: number; channels: Channel[] }

interface Notice { id: string; headline: string; body: string; kind: 'update' | 'info'; createdAt: number; action?: 'install_update' }
```

**Mutations** (reducer + validator pairs, wired to Durable Updates exactly like
`trips`): `createChannel`, `updateChannel`, `removeChannel`, `renumber`,
`addItems`, `removeItem`, `moveItem`, `replaceItems`, `setAnchor`, `setRules`,
`setBubbles`, `importLineup`, `postNotice`, `dismissNotice`.

---

## 5. Workflows

| Workflow | ID | Role |
| --- | --- | --- |
| `channelWorkflow` | `channel-<id>` | Entity. Holds one `Channel`. Query `getChannel`, `getSchedule` (flattened). Updates for every mutation. Continue-as-new every 500 mutations. |
| `lineupWorkflow` | `lineup` | Entity. Channel ordering/numbers, box-level settings, notices. Query `getLineup`. |
| `ingestWorkflow` | `ingest-<channelId>-<ts>` | Resolves a batch of `Source`s into `Item`s: archive.org metadata → file + duration; ffprobe for URLs/local; then signals `addItems` to the channel. Retries are free. |
| `healthcheckWorkflow` | Schedule, nightly | HEAD-checks every item URL, swaps `archive` items to their fallback or marks them dead, posts a notice if a channel lost > 20% of its items. Code name **MacGyver**: before it marks an item dead it tries everything on hand (fallback URL, another file in the same archive item, the same title from another archive item) and only gives up when it runs out of paper clips. |
| `updaterWorkflow` | Schedule, every 6h | Polls GitHub Releases manifest, pulls arm64 images, stages, posts an `update` notice, waits for `installNow` signal or quiet hours, applies, health-checks, rolls back on failure. |
| `importWorkflow` | `import-<ts>` | Fetches a lineup JSON from a URL, validates against schema, previews diff, applies on confirm signal. |

**Activities** (worker): `archiveMetadata(identifier)`, `probeDuration(url)`,
`headCheck(url)`, `scanLocalMedia(path)`, `searchArchive(query)`,
`fetchReleaseManifest()`, `pullImages(tags)`, `composeUp()`, `healthCheck()`.

---

## 6. MCP server (the headline feature)

Same stack as `trips-mcp`: `@modelcontextprotocol/sdk`, streamable HTTP over
Express, Zod schemas, thin Temporal helpers, `unwrapUpdateError` so a rejected
edit returns the validator's reason.

**Tools**

| Tool | Purpose |
| --- | --- |
| `list_channels` | Lineup overview: num, name, kind, item count, hours of content |
| `get_channel` | Full channel incl. items |
| `whats_on` | Now + next N across the lineup (or one channel). Great for "what's on 7 tonight?" |
| `search_archive` | archive.org advanced search → candidate items with duration/year, so Claude can propose |
| `create_channel` / `update_channel` / `remove_channel` / `renumber` | |
| `add_items` / `remove_item` / `move_item` / `replace_items` | Items by `Source`; kicks off `ingestWorkflow` to resolve durations |
| `set_anchor` | "Make the pilot air at 8pm Saturday" → computes anchor |
| `set_rules` | shuffle, dayparting ("cartoons mornings, movies after 9"), bumpers between items, block presets (Nite block, Friday night, Saturday morning; see §11) |
| `add_bubbles` | Claude writes pop-up trivia for an item from its archive metadata; validator caps count and length |
| `import_lineup` / `export_lineup` | Share lineups as JSON by URL |
| `preview_schedule` | Next 6h grid for a channel, dry-run of a proposed change |
| `box_status` | Version, uptime, disk, Temporal health, pending update |
| `check_for_update` / `install_update` | |
| `post_notice` | Writes to the notice channel / guide banner |
| `restart_player` | |

**Reaching the box from claude.ai.** A claude.ai connector needs an HTTPS URL
Anthropic can reach, so the LAN address isn't enough. Options, in order of
preference:

1. **Tailscale Funnel.** Box joins the user's tailnet on first boot (device auth
   link shown on screen). Funnel exposes only the MCP port with TLS. Zero
   infra on our side.
2. **Cloudflare Tunnel.** Same idea, needs a CF account.
3. **Our relay.** A hosted broker that boxes dial out to. Most convenient,
   but now we run infrastructure for every box sold. Defer.

Auth: the box generates a bearer token on first boot and shows it (and a QR) on
the setup screen. Add OAuth later if the connector flow needs it. Claude Code
users on the LAN can skip all of this and hit `http://<name>.local:8750/mcp`.

---

## 7. Player (`apps/player`)

SvelteKit prerendered static, served by `api`, opened by Chromium in kiosk mode
on the Pi's HDMI output.

- **Guide.** The 90s Prevue/TV Guide Channel look: scrolling grid, now/next
  columns, channel number + name on the left, a preview video in the corner.
  Fonts and chrome are the whole personality; spend design time here.
- **Playback.** One `<video>` element. MP4/MP3 progressive and HLS (hls.js for
  Chromium). On channel change: fetch schedule (cached), compute item + offset,
  set `src`, seek, play. Prefetch the next item 30s out so transitions are tight.
- **Cards.** Notice board, clock, "Please stand by", weather (if the user adds a
  provider key). Rendered in-app, no video.
- **Input.** HDMI-CEC via the kernel `cec` driver and `cec-ctl` → keyboard
  events into Chromium (small daemon). Fallback: any USB IR remote that presents
  as a keyboard (FLIRC). Keys: ch ±, 0–9 direct entry, guide, back, mute, info.
- **Setup screen.** First boot: Wi-Fi (via a hotspot captive portal, e.g.
  comitup), name the box, show MCP URL + token QR, offer the starter lineup.
- **4:3 and CRT modes.** Optional pillarbox and a light scanline shader. Cheap,
  and the people buying this want it.
- **Nostalgia layer.** Pop-up bubbles, channel-change static, Turbo Tunnel
  surfing, the GAME OVER card and the easter eggs all live here. See §11.

---

## 8. Pi image (`image/`)

- **Base.** Raspberry Pi OS Lite 64-bit. Build with `pi-gen` (or `rpi-image-gen`)
  so the image is reproducible from this repo.
- **Runtime.** Docker + Compose for Temporal and Postgres (maintained images,
  easy upgrades). Plain systemd units for our Node services and the kiosk so
  logs are one `journalctl -u` away.
- **Units.** `box-temporal` (compose), `box-worker`, `box-mcp`, `box-api`,
  `box-player` (user session, autologin, Chromium kiosk on Wayland/cage or X),
  `box-cec`. Ordering via `After=`/`Requires=`; `Restart=always`.
- **Storage.** Postgres data + media index on the SD card (or NVMe on Pi 5).
  Weekly `pg_dump` to `/var/lib/box/backup`, and an `export_lineup` snapshot so
  a dead card never loses the curation.
- **Network.** avahi → `<name>.local`. Optional Tailscale.
- **Hardening.** No default SSH password; SSH key via setup screen or disabled.
  MCP bound to tailnet/LAN only. Read-only root is a later nicety.

**Hardware (BOM, per unit, rough)**

| Part | Est. |
| --- | --- |
| Pi 4 4GB (or Pi 5 4GB) | $55–60 |
| 32GB A2 microSD | $8 |
| Official USB-C PSU | $10 |
| HDMI cable | $4 |
| 3D-printed case + hardware | $8–12 |
| USB IR remote (optional) | $12 |
| **Total** | **~$95–110** |

Target retail $180–220. Pi 4 is enough; Pi 5 if the guide animation or hls.js
decode wants headroom. Decide after the first prototype.

---

## 9. Releases and updates

- **Release workflow** (adapt from `trips`): on push to `main`, bump tag,
  create GitHub Release with generated notes, build **arm64** images for
  worker/mcp/api/player → `ghcr.io/<org>/<name>-*:<tag>`, and attach
  `manifest.json` `{ version, notes, images: { worker: "<digest>", ... } }`.
  Pinned digests, not tags, so a leaked token can't repoint boxes.
- **Box side.** `updaterWorkflow` polls the latest release manifest every 6h,
  pulls, stages, posts a notice ("v0.4.2: new dayparting rules. Press OK to
  install, or it'll install at 4am"). Applies via compose + systemd restart,
  health-checks for 2 minutes, rolls back to the previous manifest on failure.
- **Independence.** Everything the box needs at runtime is on GitHub (releases,
  ghcr.io). No dependency on a server we run. A sold box must keep working if
  we walk away.
- **Notices.** Release notes flow into the notice channel/banner as data. The
  same channel carries healthcheck warnings ("TOON LAB lost 6 items").
- **Release names.** Every release gets a sitcom-episode title: "v0.4.2 — The
  One With the Dayparting." The release workflow reads it from the tag message;
  the notice shows it as the headline.

---

## 10. Phases

**Status (2026-11-08, evening).** Phase 5 has OAuth pairing: claude.ai signs
in through the SDK auth router, and the sign-in page asks for a 6-digit code
from channel 0 (HMAC of `MCP_TOKEN`, 10-minute windows, 5 wrong tries lock it).
Request-header auth in claude.ai is a limited beta, so OAuth is the main path.
`box-funnel` (Tailscale) is not built yet. Live channels from M3U playlists
work (hls.js, XMLTV guide data, `inspect_m3u` / `add_live_channels`). Free
playlist mirrors for the big ad-supported services now publish guide data
only, so those streams need a self-hosted playlist tool. Plex is next.

**Status (2026-11-08, later).** Phase 3 has an install kit in `image/`
(install script, systemd units, cage + Chromium kiosk, CEC daemon, TM1637 LED
driver, weekly backup, `box-update`), tested in an arm64 Debian container but
not yet on a Pi. The nightly health check is built (part of Phase 4). Temporal
on the box is the CLI dev server with a SQLite file (open decision 4, for the
prototype). Channel 0 is the setup screen.

**Status (2026-11-08).** Phases 0–2 run on a laptop (`task dev`, see README).
Built so far: core (schedule math with tests, reducers, channel / lineup /
ingest workflows), worker, MCP server (20 tools), API, and the player (guide,
cards, pop-up bubbles, Turbo Tunnel, Setec). Not yet built: `healthcheckWorkflow`,
`updaterWorkflow`, `importWorkflow` (import runs in the caller for now),
dayparting and block presets (only shuffle exists), M3U/XMLTV, and Phases 3–6.
Decisions made while building:

- Lineup state holds only channel ids, box name and notices; each channel
  workflow holds its own items. The API flattens and caches every channel for
  3 s; the player polls every 10 s.
- Ingest resolves sources in an activity and signals the channel (workflows
  cannot call updates on each other). An archive.org item with no file named
  adds every program in it, one item per episode, with duplicate copies removed.
- The portable lineup file (`LineupFile`, version 1) is the format for the
  starter pack, export and import. Channels take `items` (resolved) or
  `sources` (to ingest).
- Some old archive.org transfers are stored squeezed (368×480). The player
  shows any portrait-shaped video at 4:3.

**Phase 0 — Scaffold (a day).** Repo, workspace, Taskfile `dev` that boots
Temporal dev server + worker + mcp + api + player on a laptop. Copy the
conventions from `trips` (core/worker/mcp split, namespace upsert, smoke tests).

**Phase 1 — Core + scheduler + MCP (1–2 weeks).** Types, reducers, `schedule.ts`
with unit tests (the modulo math is the one place a bug is embarrassing),
`channelWorkflow` + `lineupWorkflow`, `ingestWorkflow` with archive.org +
ffprobe activities, MCP tools through `preview_schedule`. Milestone: from Claude
Code on the laptop, "make me a Saturday-morning cartoon channel from these five
archive.org items" works end to end and `whats_on` is right.

**Phase 2 — Player (1–2 weeks).** Guide UI, playback with seek-to-offset,
channel change, cards. Milestone: full-screen Chromium on the laptop feels like
cable TV.

**Phase 3 — Pi image (1 week).** pi-gen build, systemd units, compose, kiosk,
CEC, first-boot Wi-Fi + setup screen, `<name>.local`. Milestone: flash a card,
plug into a TV, use the TV remote to change channels.

**Phase 4 — Updates + notices (a few days).** Release workflow with arm64 +
manifest, `updaterWorkflow`, notice channel, rollback test.

**Phase 5 — Remote curation (a few days).** Tailscale Funnel on the box, token
auth, connect the MCP as a claude.ai connector, curate from a phone.

**Phase 6 — Make it a product.** Case design + print tests, BOM, assembly
guide, starter PD lineup curated and vetted, lineup-import spec, Etsy listing
copy that sells the tool and shows PD content only, support plan.

**Later.** M3U/XMLTV LAN output; Jellyfin/Plex sources; ad-break/bumper
inserts; dayparting rules UI; tvOS app; the "Later" items in §11.

---

## 11. 80s, 90s and Y2K nostalgia

The box is a love letter to the TV of the 80s and 90s (with a little Y2K), and
the references are the personality.
Put one wherever a screen, a sound, a name or an error message gives room.

**The rule: homage, not copies.** We sell this box, so every reference is a nod
that a 90s kid catches, never the real thing. No logos, no clips, no theme
songs, no ripped sound effects, and no trademarked show or network names on
on-screen labels, the case, or the Etsy listing. Original art and sounds in the
style of the era are fine. Full names are fine where only we see them: code
names, commit messages, release titles phrased as jokes, this file.

### Features

| Nod to | What we build | Where |
| --- | --- | --- |
| VH1 *Pop-Up Video* | **Pop-up bubbles.** Trivia bubbles appear over the video with an original "bloop" sound. Claude writes them from archive.org metadata via `add_bubbles`. Toggle with INFO. | player, core `Bubble`, MCP |
| *Nick at Nite* | **Nite block.** A `set_rules` preset that turns a channel into a classic-TV block from 8pm to 6am: old sitcom-style bumpers, a crescent-moon bug in the corner, the "Nite" spelling on the guide. | rules, player |
| ABC *TGIF* | **Friday-night block** preset: family-sitcom lineup 8–10pm Fridays, with a hosted-block bumper between items. | rules |
| Saturday-morning cartoons | **Saturday-morning block** preset: cartoons 7am–noon, cereal-commercial-style bumpers, then the channel goes back to normal. | rules |
| *Battletoads* | **Turbo Tunnel.** Hold CH+ and the box surfs at speed: speed lines, the channel number flashes past, release to land. **GAME OVER card**: a dead channel shows "GAME OVER — CONTINUE?" with a 9-to-0 countdown, then tunes to the next channel. | player input, cards |
| *Biker Mice from Mars* | **Last Chance Garage.** The diagnostics / repair screen (box status, logs, rollback). A successful update ends with "LET'S ROCK AND RIDE!" on the notice banner. Healthcheck failures blame the cheese-themed villain: "Somebody sabotaged TOON LAB." | setup + status screen, notices |
| *MacGyver* | **MacGyver** is the healthcheck's code name and personality (§5). Its notices read like a fix-it montage: "Swapped 3 dead links with a paper clip and a fallback URL." | healthcheck, notices |
| *Friends* | **"The One With…"** release names (§9). A **marathon mode** for any channel: plays items in order with a "MARATHON" banner, the way cable ran ten episodes on a holiday. | releases, rules |
| *Sneakers* | **Setec easter egg.** Type channel 1992 and the guide letters scramble, then settle into "TOO MANY SECRETS", like the Scrabble tiles. The repo name is the voiceprint line. | player |
| *Back to the Future* | **Time circuits.** INFO on the guide opens a three-row LED panel (DESTINATION / PRESENT / LAST DEPARTED) in red, green and amber. Dial a time and it shows what will be on, through `whats_on`. Turbo Tunnel past channel 88 flashes "88 MPH." The Last Chance Garage shows power as "1.21 GIGAWATTS" when the CPU spikes. | guide, status screen |
| *Buckaroo Banzai* | **Motto of the shared clock:** "No matter where you go, there you are." It is the tagline on the setup screen, because you always land mid-episode. **Sequel tease card:** when a channel loops back to its first item, a card promises a sequel that will never air ("Coming soon: TOON LAB Against the World Crime League"). | setup screen, cards |
| *Family Ties* | **Sign-off vanity card.** When the box goes to standby, it shows one second of an original dog photo with "Sit, Ubu… no. Sit. Good dog." The setup screen lets the owner swap in a photo of their own dog. **Channel idents** use the opening-credits look: hand-sketched portraits that fade into the picture. | player, setup screen |
| *MTV Cribs* | **Box tour.** The Last Chance Garage opens with "Welcome to my crib." It tours the box room by room: the fridge is the disk ("stocked with 41 GB of PD cartoons"), the garage is the worker, the bedroom is Temporal ("this is where the magic happens"). | status screen, `box_status` |
| Prevue / TV Guide Channel | The guide itself (§7). | player |
| Cable static and VHS | **Channel change:** half a second of static and a VHS tracking wobble before the picture locks. Off by default for people who channel-surf fast. | player |
| Emergency broadcast tests and "technical difficulties" slides | **Please Stand By card** for buffering and outages; the API 500 page says "We are experiencing technical difficulties." | cards, api |
| Dial-up internet | **Setup Wi-Fi join** plays an original modem-handshake screech while it connects. Mute with any key. | setup screen |
| "You've got mail" | **Notice chime**: an original voice clip, "You've got notices," the first time a notice appears each day. | notices |
| Video rental stores | `export_lineup` adds a "Be kind, rewind" line to the JSON; the backup screen shows a VHS clamshell. | MCP, setup |
| *The X-Files* | `search_archive` with no results returns "The truth is out there. Try another search." | MCP |
| *Saved by the Bell* | Pause freezes the frame and shows "TIME OUT" in a yellow bubble font. | player |
| 90s infomercials | The first-boot tour is a 30-second infomercial: "But wait, there's more!" before the MCP QR code. | setup screen |

### Later

- **Riff mode.** Late-night movie channel with Claude-written heckling as
  bubbles, in the spirit of the robots-in-the-theater show that riffed on the
  same public-domain films we ship.
- **Konami-style code** on the remote (up up down down…) unlocks a hidden
  "rerun" channel.
- **Weather card** with smooth-jazz hold music and the blue-gradient local
  forecast look.
- **Fake commercial breaks** of PD 50s–90s ads at item boundaries, behind a
  setting.
- **Case badge** in a 90s cable-company logo style, with an original name.

---

## 12. Open decisions

1. **Name.** Needed before Phase 3 (hostname, units, MCP server name).
2. **Pi 4 vs Pi 5.** Prototype on whatever is on hand; decide on measured guide
   frame rate and hls.js CPU.
3. **Remote input.** CEC-first is the elegant answer but TV CEC support is
   uneven. Ship the IR remote in the box or make it an add-on?
4. **Temporal persistence.** Postgres in Compose (recommended) vs the dev
   server with `--db-filename` (lighter, single binary, officially "not for
   production" but fine for one user on one box). Start with Postgres; revisit
   if RAM is tight on a 4GB Pi 4.
5. **Remote access.** Tailscale Funnel is the default. Confirm the claude.ai
   connector flow is happy with bearer-token auth or whether OAuth is required.
6. **Starter lineup.** Who vets PD status? Prelinger and NASA are safe; "PD
   features" lists online are often wrong. Keep the first pack small and sure.
7. **Reference check.** Before the Etsy listing goes live, review every
   on-screen label, sound and case marking against the §11 rule. Rename
   anything that uses a real show or network name.

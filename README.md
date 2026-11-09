# Retro Cable Box

A Raspberry Pi box that turns media you point it at into a 24/7 retro cable
lineup: a 90s-style channel guide, channels on a shared clock (you tune in
mid-show, like real TV), and an MCP server so your AI agent (any MCP client: Claude, ChatGPT,
Cursor, a local model) can program the channels.

`plan.md` is the full plan. This README tells you how to run what exists today.
The docs site (`docs/`, published to GitHub Pages) is for owners and builders:
the build guide, parts and case files, setup, how to connect an agent
securely, plugins, and the shop. Build it with `pnpm docs:build`; the output
is in `docs/_site`.

## What works now (Phases 0–2, on a laptop)

- **Channels on a shared clock.** Every channel loops its items. The player
  works out what is on right now and how far in, then seeks there.
- **The TV.** Power-on screen, channel change with static and a green channel
  readout, an info banner, the guide (live picture in the corner, a blue
  now/next grid), clock and bulletin-board channels, PLEASE STAND BY, GAME OVER
  for empty channels, pop-up trivia bubbles, CRT mode, Turbo Tunnel surfing,
  and channel 1992.
- **Starter lineup.** Six public-domain channels from archive.org (school films,
  1930s cartoons, NASA, horror, matinee, vintage ads) plus a clock and a
  bulletin board. A fresh box imports it on first boot.
- **MCP server.** 25 tools: search archive.org, build and edit channels, set air
  times, shuffle, write pop-up bubbles, import and export lineups, post notices,
  add live channels from an M3U playlist and attach guide data to them.
- **Live channels.** Give your agent an M3U / IPTV playlist URL (free live TV
  services through a playlist tool, iptv-org, HDHomeRun, ErsatzTV, Tunarr).
  The agent picks channels and gives them numbers. They play through hls.js, and
  the guide shows program titles when the playlist has XMLTV guide data. When
  it has none, `set_live_guide` attaches a separate XMLTV file and finds the
  channel in it by name.
- **Plugins.** The box knows no streaming service. A plugin adds that
  knowledge: a `retro-cable-box.json` manifest (data, never code) that anyone
  can publish in a GitHub repo. It can hold stream recipes (an extra step
  before a stream plays, such as a new session on every tune) and channels.
  Register the repo with `install_plugin`; the box creates the channels and
  installs new GitHub releases of the repo every night. See
  [Plugins](#plugins).
- **Programming blocks.** `set_block`: at set times another channel's shows
  air on a channel (Saturday-morning cartoons 7–11, a Halloween takeover).
  The channel workflow's durable timers arm each airing 6 hours ahead (it
  shows on the guide), announce it at the start, and return to regular
  programming, in progress, at the end. A box that was off catches up.
- **Self-repair from the TV.** When a video will not play, the TV signals its
  channel. The workflow checks the media with an activity, swaps in the same
  film from elsewhere or skips it, and posts a notice.
- **Approval on the TV.** `propose_channel` puts a card on the TV; OK adds
  the channel, BACK declines, and it expires after 72 hours. Only the TV can
  answer (the API's `/api/proposals/:id`; MCP has no tool for it).
- **Pairing for agent apps.** When the box has a public URL, an agent app
  that signs in with OAuth (for example, a claude.ai custom connector) pairs
  with the 6-digit code on channel 0.
- **Temporal.** One entity workflow per channel and one for the lineup. Every
  edit is a validated Durable Update, so a bad edit comes back with the reason.

- **Nightly health check ("MacGyver").** Every link is tested at 3:30 am.
  Broken items are repaired from a fallback URL or the same archive.org item
  when possible; the rest stop airing, and a notice goes on the bulletin board.
  The agent can run it any time (`run_healthcheck`).
- **Channel 0: setup.** The MCP address, a QR code for it, and the token.
- **Pi install kit** (`image/`): one script turns Raspberry Pi OS Lite into a
  box: systemd services, Chromium kiosk, HDMI-CEC remote, front-panel LED,
  weekly backups and `box-update`. See [image/README.md](image/README.md).
  Tested in an arm64 container; not yet on real hardware.

Not done yet: release-based self-update (Phase 4), the Tailscale Funnel step
of Phase 5 (`box-funnel`), Plex as a source, the case and the product (Phase 6). See `plan.md` §10.

## Run it

You need Node 22, pnpm 10, [Task](https://taskfile.dev), the Temporal CLI and
ffmpeg (for `ffprobe`). On macOS:

```sh
brew install go-task temporal ffmpeg
```

Then:

```sh
task dev
```

This starts Temporal, the worker, the MCP server, the API and the player. The
first run imports the starter lineup. Ingest takes about 20 seconds.

| What | Where |
| --- | --- |
| The TV | http://127.0.0.1:5173 |
| MCP | http://127.0.0.1:8750/mcp |
| API | http://127.0.0.1:8760/api/guide |
| Temporal UI | http://127.0.0.1:8233/namespaces/box |

Open the TV full screen (⌃⌘F in Chrome) and press any key to turn it on.
Channels persist in `.temporal/dev.db`. `task reset` starts a fresh box.

## The remote

| Key | Does |
| --- | --- |
| ↑ / ↓ (or PgUp / PgDn, + / −, scroll wheel) | Channel up / down |
| Hold ↑ or ↓ | Turbo Tunnel: surf fast, land when you let go |
| 0–9 | Tune a channel number directly |
| G or Enter | Guide (↑↓ select, ←→ look ahead in time, Enter tune, G close; click a row to select it, click again to tune) |
| I | Info banner |
| M | Mute |
| B | Pop-up bubbles on or off |
| C | CRT mode (4:3, scanlines) |
| 0 or S | Setup: how to connect your agent |
| 1 9 9 2 | Too many secrets |

On a phone or tablet: swipe up or down to change channel, tap for the info
banner, long-press for the guide. In the guide, swipe up/down to select,
swipe left/right to look ahead in time, tap a row to select it and tap again
to tune. To watch on a phone over Tailscale, serve the built TV from the API
(the Vite dev server sends hundreds of modules and can leave a phone white):

```sh
pnpm --filter player build
tailscale serve --bg --https=8443 http://127.0.0.1:8760
```

Then open `https://<laptop>.<tailnet>.ts.net:8443` on the phone (tailnet
only). Rebuild after player changes.

## Things to try

1. Turn on the TV, then flip through channels 2–9.
2. Open the guide with G and move through the grid.
3. Type 1992.
4. Connect your agent to the box and program a channel. Any MCP client works:
   give it the Streamable HTTP address `http://127.0.0.1:8750/mcp`. For
   example, with Claude Code:

   ```sh
   claude mcp add --transport http retro-cable-box http://127.0.0.1:8750/mcp
   ```

   Then ask your agent, for example:

   - "What's on the box right now?"
   - "Make me a Saturday-morning cartoon channel on 11 from public-domain
     cartoons on archive.org."
   - "Add pop-up bubbles to whatever is on Toon Lab right now."
   - "Make Night of the Living Dead start at 11pm tonight on Creature Feature."

   The TV picks up changes within about 10 seconds.

5. Put your own video files in `media/` and ask your agent to add them as
   `local` sources.
6. Live TV: "Look at this playlist and put the 90s channels on 20 and up:
   <M3U URL>". The agent uses `inspect_m3u`, then `add_live_channels`.

## Plugins

A plugin repo publishes `retro-cable-box.json` in its GitHub releases (as a
release asset, or as a file at the release tag):

```json
{
  "plugin": 1,
  "id": "my-service-sessions",
  "name": "My Service sessions",
  "version": "1.0.0",
  "streams": [
    {
      "match": "streams\\.example\\.com/live/([0-9a-f]{24})",
      "session": { "url": "https://api.example.com/start?channel={1}&device={device}" },
      "playlist": "{r.server}/live/{1}/master.m3u8?token={r.token}"
    }
  ],
  "channels": [
    { "id": "retro-one", "num": 120, "name": "RETRO ONE", "kind": "live",
      "items": [{ "id": "s", "title": "LIVE", "durationSec": 0,
                  "source": { "kind": "hls", "url": "https://streams.example.com/live/0123456789abcdef01234567" } }] }
  ]
}
```

- **Stream recipe.** `match` is a regular expression for the stream URLs it
  handles. It must not match every URL. On each tune the box makes the
  `session` GET request (optional) and fills the `playlist` template.
  Fields: `{1}`…`{9}` (match groups), `{url}`, `{device}`, `{uuid}`,
  `{r.path.to.field}` (from the session response JSON).
- **Channels.** The lineup-file channel format. An update adds only channels
  that the plugin never offered before, so a channel the owner removed stays
  removed.
- **Updates.** The repo's releases control them. `owner/repo` installs the
  latest release and installs each new release in the nightly check.
  `owner/repo@tag` pins one release.
- **Limits.** A plugin cannot run code. A plugin from a GitHub repo cannot
  make the box call the owner's own network (LAN, loopback, tailnet,
  `.local`), because it updates itself from someone else's releases. A
  manifest the owner's agent writes in place, or one from a URL the owner
  gives, can use the owner's network (for example, a media server on the LAN).
- **Owner's choice.** The box does not check rights at runtime. The owner
  decides what plays: their own files, servers on their network, or sources
  they name. Only what ships with the box (the starter lineup) and the
  official channel packs are vetted public domain.

Agent tools: `install_plugin` (a repo, or a `manifest` written in place),
`list_plugins`, `remove_plugin`, `update_plugins`, `test_stream`.

## Put it on a Pi

See [image/README.md](image/README.md). In short: flash Raspberry Pi OS Lite
(64-bit) with hostname `retrocable`, then:

```sh
ssh box@retrocable.local
curl -fsSL https://raw.githubusercontent.com/perpetual-static/retro-cable-box/main/image/install.sh | sudo bash
```

## Checks

```sh
task test    # unit tests: shared-clock math, reducers, archive file picking
task check   # type-check every package
task smoke   # end-to-end: worker, MCP and API against the running stack
pnpm --filter @box/mcp smoke:oauth   # OAuth pairing flow (needs MCP_TOKEN + PUBLIC_MCP_URL)
PLAYLIST=<m3u url> pnpm --filter @box/mcp smoke:live   # live channel from a playlist
./image/test-in-container.sh   # install.sh on arm64 Debian, then the services + smoke tests
```

## Layout

```
packages/core     @box/core — types, schedule math, reducers, workflows, archive.org client, Temporal client
services/worker   Temporal worker + ingest activities (archive.org metadata, ffprobe)
services/mcp      MCP server (Streamable HTTP, POST /mcp)
services/api      Guide JSON for the player, /media for local files, serves the built player
apps/player       SvelteKit static app: the TV
lineups           starter.json — the public-domain starter lineup
```

## Notes

- **Public domain.** Every starter item is marked public domain on archive.org
  or is a NASA work. Vet the pack before anything ships (plan.md open decision
  6). The cartoons use characters that are still trademarks, even where the
  films are public domain.
- **MCP auth.** Set `MCP_TOKEN` to require `Authorization: Bearer <token>`.
  Set `PUBLIC_MCP_URL` too and agent apps that use OAuth can pair with the
  code on channel 0.
  To try pairing on a laptop, put both in `.env`
  (`PUBLIC_MCP_URL=http://127.0.0.1:8750/mcp`).
- **Live channel sources.** The box names no service. Free ad-supported
  services allow their streams only in their own apps, so a playlist from them
  is your choice on your own box.
- **Ports and Temporal address** come from `.env` (see `.env.example`).

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). You may use, change and share
this project for any noncommercial purpose, including building a box for
yourself. Selling boxes or the software needs the author's permission.
Plugins live in their own repos, under their authors' own licenses.


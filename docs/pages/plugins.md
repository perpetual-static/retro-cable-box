---
num: 7
name: PLUGINS
title: Plugins
slug: plugins
---

# Plugins

The box ships with no knowledge of any streaming service. A plugin adds it.
Anyone can publish a plugin, and any box owner can install it.

A plugin is one JSON file, `retro-cable-box.json`, in a GitHub repo. It is
data, never code, so a plugin cannot run programs on the box. It can hold two
things:

- **Channels.** Ready-made channels in the lineup-file format.
- **Stream recipes.** An extra step before a stream plays. For example, some
  services need a new session on every tune, or the picture drifts away from
  the guide.

## Install a plugin

Ask your agent:

> Install the plugin from someone/their-plugin.

The agent calls `install_plugin`. The box creates the plugin's channels (it
skips a channel when its number or id is already taken) and starts to use its
stream recipes.

| You give | The box installs |
| --- | --- |
| `owner/repo` | The latest release, then each new release in the nightly check |
| `owner/repo@v1.2.0` | That release only; it never updates |
| A URL to a `retro-cable-box.json` (https, or http on your own network) | That file; it never updates |

Other tools: `list_plugins`, `remove_plugin`, `update_plugins` (look for new
releases now), and `test_stream` (show what the box will play for a URL).

## Publish a plugin

1. Make a public GitHub repo.
2. Put `retro-cable-box.json` at the root of the repo:

```json
{
  "plugin": 1,
  "id": "my-service-sessions",
  "name": "My Service sessions",
  "description": "A new session on every tune, so the picture matches the guide.",
  "version": "1.0.0",
  "streams": [
    {
      "match": "streams\\.example\\.com/live/([0-9a-f]{24})",
      "session": { "url": "https://api.example.com/start?channel={1}&device={device}" },
      "playlist": "{r.server}/live/{1}/master.m3u8?token={r.token}"
    }
  ],
  "channels": [
    {
      "id": "retro-one", "num": 120, "name": "RETRO ONE", "kind": "live",
      "items": [{
        "id": "stream", "title": "LIVE", "durationSec": 0,
        "source": { "kind": "hls", "url": "https://streams.example.com/live/0123456789abcdef01234567" }
      }]
    }
  ]
}
```

3. Publish a GitHub release (for example, `v1.0.0`). The box reads the file
   from the release: a release asset named `retro-cable-box.json`, or the file
   at the release tag.

Boxes update only when you publish a new release. A push to the main branch
does not change any box.

## Stream recipes

| Field | Means |
| --- | --- |
| `match` | A regular expression (case-insensitive) for the stream URLs that the recipe handles. It must not match every URL. |
| `session.url` | Optional. A GET request that the box makes on every tune. The response must be JSON. |
| `session.headers` | Optional. Headers for that request. |
| `playlist` | A template for the playlist URL that the box plays. |

The templates fill these fields:

| Field | Value |
| --- | --- |
| `{1}` … `{9}` | The groups in `match` |
| `{url}` | The stream URL on the channel |
| `{device}` | A random id that stays the same while the box runs |
| `{uuid}` | A new random id |
| `{r.path.to.field}` | A value from the session response |

Before you publish, ask your agent to check a recipe with `test_stream`. It
makes the session request for real and tells you if the result is a playable
playlist.

## Channels

A plugin's `channels` use the same format as a lineup file (the agent's
`export_lineup` tool makes one). When a new release adds channels, the box
creates only the channels that the plugin never offered before. A channel
that the owner removed does not come back.

## Rules

- A plugin cannot run code.
- A plugin from a GitHub repo cannot make the box call the owner's own
  network (LAN addresses, `localhost`, `.local` names, tailnet addresses),
  because it updates itself from someone else's releases.
- A manifest your agent writes in place, or one from a URL you give, can use
  your own network: for example, a recipe for a media server on your LAN.
- A recipe that matches every stream is refused.
- When two plugins match the same URL, the one installed first wins.
- A box holds up to 30 plugins; a plugin holds up to 20 recipes and 100
  channels.
- Publish only streams that you have the right to share.

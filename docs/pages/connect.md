---
num: 5
name: CONNECT
title: Connect your agent
slug: connect
---

# Connect your agent

The box has an MCP server. Any MCP client can use it: Claude, ChatGPT,
Cursor, a local model, or your own script. Pick the method that fits where
your agent runs. Use the first method that works for you: each one after it
opens the box to more of the network.

| Where the agent runs | Method | Who can reach the box |
| --- | --- | --- |
| A computer on your home network | [1. Home network](#1-home-network) | Devices on your network, with the token |
| Your own devices, away from home | [2. Private tailnet](#2-private-tailnet) | Only your Tailscale devices, with the token |
| A cloud app (for example, a claude.ai connector) | [3. Public address with pairing](#3-public-address-with-pairing) | The internet can reach it; only paired apps and the token get in |

## Before you start

- **The box has three services.** The MCP server (port 8750) is for agents.
  The TV app (port 8760) and the workflow engine (ports 7233 and 8233) are
  for the box itself. Give an agent access to port 8750 only.
- **Do not forward ports on your router.** None of the methods below need it.
- **Keep the token secret.** Channel 0 shows it. Anyone with the token can
  program the box.

## 1. Home network

For an agent on a computer in your home: Claude Code, Cursor, a desktop
app, or a local model.

1. Type **0** on the remote. Note the MCP address and the token.
2. Add the box to your agent as a Streamable HTTP MCP server:
   - **Address:** `http://retrocable.local:8750/mcp`
   - **Header:** `Authorization: Bearer <token>`

For example, Claude Code:

```sh
claude mcp add --transport http retro-cable-box http://retrocable.local:8750/mcp \
  --header "Authorization: Bearer <token>"
```

The connection is plain HTTP inside your home network. Use this method on a
network you trust. On a shared network (a dorm, an office), use method 2.

## 2. Private tailnet

For an agent on your own laptop or phone when you are away from home. A
[Tailscale](https://tailscale.com) tailnet is a private, encrypted network
of your own devices. The box gets an HTTPS address that only your devices
can open.

1. Install Tailscale on the box and sign in:

   ```sh
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. Serve the MCP server to your tailnet only:

   ```sh
   sudo tailscale serve --bg --https=443 http://127.0.0.1:8750
   ```

3. Install Tailscale on the device that runs your agent.
4. Give the agent the address `https://retrocable.<your-tailnet>.ts.net/mcp`
   and the same `Authorization: Bearer <token>` header.

To stop: `sudo tailscale serve --https=443 off`.

## 3. Public address with pairing

For an agent that runs in the cloud, such as a claude.ai custom connector.
The cloud app must reach the box from the internet, so the box gets a public
HTTPS address. Two things protect it:

- **Pairing.** An agent app signs in with OAuth. The box asks for the 6-digit
  pairing code that channel 0 shows. The code changes every 10 minutes, and 5
  wrong codes lock pairing. Only someone who can see your TV can pair.
- **The token.** Clients that send a header can still use the token.

When an app pairs, the box puts a notice on the TV. Ask your agent for
`box_status` to see the paired apps, and `forget_connection` to remove one.

### With Tailscale Funnel

Funnel gives the box a public HTTPS address without router changes.

1. Install Tailscale on the box (method 2, step 1).
2. Let the box use Funnel. The first time, Tailscale shows a link to turn it
   on for your tailnet.

   ```sh
   sudo tailscale funnel --bg --https=443 http://127.0.0.1:8750
   ```

3. Tell the box its public address. Add this line to `/etc/box/box.env`:

   ```sh
   PUBLIC_MCP_URL=https://retrocable.<your-tailnet>.ts.net/mcp
   ```

4. Restart the services: `sudo systemctl restart box-mcp box-api`.
5. In your agent app, add a custom connector with that address. When the
   app opens the sign-in page, type the pairing code from channel 0.

To stop: `sudo tailscale funnel --https=443 off`, then remove the
`PUBLIC_MCP_URL` line and restart the services.

### With Cloudflare Tunnel

If you have a domain on Cloudflare, a tunnel works the same way.

1. Install `cloudflared` on the box and create a tunnel. Route one hostname
   (for example, `tv.example.com`) to `http://127.0.0.1:8750` only.
2. Set `PUBLIC_MCP_URL=https://tv.example.com/mcp` in `/etc/box/box.env`
   and restart the services.
3. Add the connector in your agent app and pair, as above.

Do not put a Cloudflare Access login in front of the tunnel. Agent apps
cannot complete that login. The pairing code is the gate.

## What an agent can do

An agent can program channels, schedule shows, add trivia, post notices and
install [plugins](plugins.html). It can add files from the box's media folder
only. It cannot run commands on the box, and it cannot read other files.
Plugins cannot make the box call devices on your network.

## If the token leaks

1. Put a new token in `/etc/box/box.env` (`MCP_TOKEN=`). Use 32 random hex
   characters, for example from `openssl rand -hex 16`.
2. Restart the services: `sudo systemctl restart box-mcp box-api`.
3. Ask your agent for `box_status`, then `forget_connection` for each paired
   app that you do not know.

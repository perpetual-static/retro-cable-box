---
num: 9
name: INSIDE
title: Under the hood
slug: temporal
---

# Under the hood

The box runs on [Temporal](https://temporal.io), a workflow engine. Every
channel is a workflow that lives as long as the channel does. Temporal keeps
its state, its timers and its history safe through restarts and power cuts.
Open the workflow UI (`http://<box>:8233`, or http://127.0.0.1:8233 on your
computer) next to the TV to watch it work.

Temporal is never in the playback path. The TV computes what is on from the
schedule and the clock, so a busy workflow never makes the picture stutter.

## The workflows

| Workflow | Lives | Does |
| --- | --- | --- |
| `lineup` | Always | The box name, the channel list, notices, plugins, and proposals waiting on the TV |
| `channel-<id>` | As long as the channel | One channel's shows, rules, blocks and repairs. Every edit from an agent is a validated update. |
| `ingest-…` | Minutes | Finds each video on archive.org or a URL and measures it, with retries, then hands the shows to the channel |
| `proposal-<id>` | Up to days | A channel an agent proposed, waiting for OK on the TV |
| `healthcheckWorkflow` | Nightly, 3:30 am | Checks every link, repairs what it can, installs new plugin releases |

## Three things to watch

### 1. Programming blocks: timers that survive a power cut

Ask your agent: *"Every Saturday from 7 to 11 am, put TOON LAB's cartoons on
channel 6."* (`set_block`)

The channel workflow sets durable timers:

1. **Six hours before:** it copies TOON LAB's shows for this airing, in a new
   shuffle, and the block appears on the guide.
2. **At 7:00:** it puts "SATURDAY MORNING starts now on 6" on the guide. The
   show that was on is cut, like real TV.
3. **At 11:00:** it removes the block. Regular programming comes back already
   in progress.

*Watch this:* set a block for a few minutes from now, then pull the power (or
stop the box) before it starts. When the box comes back, the workflow wakes
up, sees that it missed its time, and catches up. In the workflow UI, the
channel's history shows each `TimerStarted` and `TimerFired`.

### 2. Self-repair: an event from the TV

When a video does not play, the TV tells its channel (a signal). The channel
workflow runs a check (an activity, with retries): can the file be reached,
and if not, is the same film somewhere else in the same archive.org item?
Then the workflow fixes the show or skips it, and puts a notice on the
bulletin board: *"MacGyver fixed SCHOOL FILMS."*

*Watch this:* the repair takes a few seconds, while the TV waits 10 seconds
before it tries again. So a broken video usually comes back on its own, and
the channel's history shows the whole story: the signal, the activity and its
result, and the notice.

The nightly health check still runs for links that nobody watched.

### 3. Approval on the TV: a person in the loop

Ask your agent: *"Propose a channel of 1950s guidance films on 30."*
(`propose_channel`)

The proposal workflow finds the films first, so the card shows real titles.
Then a card appears on the TV:

> NEW CHANNEL PROPOSED · 30 SOCIAL GUIDANCE · OK ADD IT · BACK NO THANKS

The workflow waits for the remote, for up to three days by default. While it
waits, it costs nothing. OK creates the channel and BACK declines it. If
nobody answers, the proposal expires. The agent cannot answer for you: only
the TV can, so a proposal always needs a person in the room.

*Watch this:* the proposal workflow in the UI shows its wait as one open
timer, and your answer as an update with the result.

## Why Temporal for a cable box

- **Edits never break a channel.** Each edit is checked before it applies, so
  an agent's mistake comes back as a reason, not as a broken channel.
- **Long waits are free.** A block next Saturday, a proposal that waits three
  days and a nightly check are all timers, not programs that sit and wait.
- **The history is the logbook.** Every edit, repair, block and approval is in
  the channel's history, with the time and the details.
- **It survives the power cord.** A Pi under a TV gets unplugged. Temporal
  keeps every timer and every change on disk and carries on when it starts
  again.

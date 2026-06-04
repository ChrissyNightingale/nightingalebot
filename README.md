# NightingaleBot

Discord bot that watches Spotify, YouTube, and Twitch for new activity from
**Chrissy Nightingale** and posts to the Nightingale Discord server.

Runs on a 10-minute cron under GitHub Actions — no hosting required. State is
persisted in `state.json` and committed back to the repo each tick.

## What it posts

| Source  | Trigger                    | Posts to              |
|---------|----------------------------|-----------------------|
| Spotify | New album / single appears | Music & Videos        |
| YouTube | New video upload           | Music & Videos        |
| Twitch  | Stream goes live           | Twitch Live Streams   |

Twitch posts fire on the transition `offline → live` only. Stream end is
recorded silently (no spam on ending).

First run "seeds" state — already-published content is recorded but not
re-announced. The bot kicks in for the **next** release / video / live stream
after deployment.

## Setup

### 1. Create the Discord bot

1. Go to https://discord.com/developers/applications → New Application
2. Name: **NightingaleBot**
3. Bot tab → Reset Token → copy the token (this becomes the
   `NIGHTINGALE_DISCORD_BOT_TOKEN` secret below)
4. Privileged Gateway Intents — leave **all off**
5. OAuth2 → URL Generator:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Embed Links`
6. Open the generated URL, invite NightingaleBot to guild
   `1475433665537511536`
7. In Discord, give the bot role access to the two target channels:
   - `1476195529129066721` (Music & Videos)
   - `1476199961543708774` (Twitch Live Streams)

### 2. Spotify Developer app

1. https://developer.spotify.com/dashboard → Create App
2. App name: `NightingaleBot Watcher`. Any redirect URI (unused).
3. Settings → copy **Client ID** and **Client Secret**.

### 3. Twitch Developer app

1. https://dev.twitch.tv/console/apps → Register Your Application
2. Name: `NightingaleBot`, Category: *Application Integration*
3. OAuth Redirect URL: `https://localhost` (unused; we use client credentials)
4. Copy **Client ID** and generate / copy **Client Secret**.

### 4. Repo secrets

In this repo on GitHub → Settings → Secrets and variables → Actions, add:

| Secret name                       | Value                          |
|-----------------------------------|--------------------------------|
| `NIGHTINGALE_DISCORD_BOT_TOKEN`   | Discord bot token from step 1  |
| `SPOTIFY_CLIENT_ID`               | Spotify client id from step 2  |
| `SPOTIFY_CLIENT_SECRET`           | Spotify client secret          |
| `TWITCH_CLIENT_ID`                | Twitch client id from step 3   |
| `TWITCH_CLIENT_SECRET`            | Twitch client secret           |

### 5. First run

Push to `main`, then either wait ~10 min for cron or trigger
**NightingaleBot watch** under the Actions tab. The first run only seeds
state — no posts. The second run onward will post any new activity.

## Local development

```bash
# Drop secrets into .env (gitignored)
NIGHTINGALE_DISCORD_BOT_TOKEN=...
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
TWITCH_CLIENT_ID=...
TWITCH_CLIENT_SECRET=...

# Load env + run
node --env-file=.env src/index.js
```

## Config

Constants live at the top of `src/index.js` (`cfg` object) — guild and channel
IDs, Spotify artist ID, YouTube handle, Twitch login. Edit there if any IDs
change.

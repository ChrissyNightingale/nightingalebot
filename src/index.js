// NightingaleBot — watches Spotify / YouTube / Twitch for Chrissy Nightingale
// and posts new releases & live streams to Discord. Designed to run on a cron
// schedule under GitHub Actions; state persisted in ../state.json and committed
// back to the repo by the workflow.

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '..', 'state.json');

const cfg = {
  guildId: '1475433665537511536',
  musicChannelId: '1476195529129066721',
  twitchChannelId: '1476199961543708774',
  spotifyArtistId: '0eIGTeyCGI7ztWfLBd0v4Y',
  youtubeHandle: 'ChrissyNightingale',
  twitchLogin: 'chrissynightingale',
  market: 'US',
  // Color palette per source — Discord embed bar color.
  colors: { youtube: 0xFF0000, spotify: 0x1DB954, twitch: 0x9146FF, release: 0xFF3366 },
};

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
};

const DEFAULT_STATE = {
  youtube: { channelId: null, lastVideoIds: [] },
  spotify: { lastAlbumIds: [] },
  twitch: { isLive: false, lastStreamId: null },
};

async function loadState() {
  try {
    const s = JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
    // Migrate missing keys defensively.
    s.youtube ??= { channelId: null, lastVideoIds: [] };
    s.spotify ??= { lastAlbumIds: [] };
    s.twitch ??= { isLive: false, lastStreamId: null };
    s.youtube.lastVideoIds ??= [];
    s.spotify.lastAlbumIds ??= [];
    return s;
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

async function saveState(s) {
  await fs.writeFile(STATE_PATH, JSON.stringify(s, null, 2) + '\n');
}

// ---------------------------------------------------------------- Discord ---

async function discordPost(channelId, { content, embed, mentionEveryone = false }) {
  const token = env('NIGHTINGALE_DISCORD_BOT_TOKEN');
  const body = {
    content: mentionEveryone
      ? `@everyone${content ? '\n' + content : ''}`
      : content || '',
    allowed_mentions: mentionEveryone ? { parse: ['everyone'] } : { parse: [] },
  };
  if (embed) body.embeds = [embed];

  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'NightingaleBot (+https://chrissynightingale.com)',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    throw new Error(`Discord ${res.status}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------- YouTube ---

async function resolveYouTubeChannelId(state) {
  if (state.youtube.channelId) return state.youtube.channelId;
  const res = await fetch(`https://www.youtube.com/@${cfg.youtubeHandle}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 NightingaleBot' },
  });
  const html = await res.text();
  const m =
    html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/) ||
    html.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/);
  if (!m) throw new Error('Could not resolve YouTube channel ID from @handle page');
  state.youtube.channelId = m[1];
  console.log(`[youtube] resolved channelId: ${m[1]}`);
  return m[1];
}

async function checkYouTube(state) {
  const channelId = await resolveYouTubeChannelId(state);
  const res = await fetch(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    { headers: { 'User-Agent': 'Mozilla/5.0 NightingaleBot' } }
  );
  if (!res.ok) throw new Error(`YouTube RSS ${res.status}`);
  const xml = await res.text();

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  const seen = new Set(state.youtube.lastVideoIds);
  const isSeed = state.youtube.lastVideoIds.length === 0;
  const newItems = [];

  for (const e of entries) {
    const vid = (e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    if (!vid || seen.has(vid)) continue;
    const title = (e.match(/<title>([^<]+)<\/title>/) || [])[1];
    const link = (e.match(/<link rel="alternate" href="([^"]+)"/) || [])[1];
    const published = (e.match(/<published>([^<]+)<\/published>/) || [])[1];
    const thumb = (e.match(/<media:thumbnail url="([^"]+)"/) || [])[1];
    if (!isSeed) newItems.push({ vid, title, link, published, thumb });
    state.youtube.lastVideoIds.push(vid);
  }
  state.youtube.lastVideoIds = state.youtube.lastVideoIds.slice(-30);

  if (isSeed) {
    console.log(`[youtube] seeded ${entries.length} videos (no posts on first run)`);
    return;
  }

  // Post oldest -> newest so the channel reads in publish order.
  for (const v of newItems.reverse()) {
    await discordPost(cfg.musicChannelId, {
      content: '🎬 New video from Chrissy Nightingale!',
      embed: {
        title: v.title,
        url: v.link,
        color: cfg.colors.youtube,
        image: v.thumb ? { url: v.thumb } : undefined,
        timestamp: v.published,
        footer: { text: 'YouTube' },
      },
    });
    console.log(`[youtube] posted ${v.vid}`);
  }
}

// ---------------------------------------------------------------- Spotify ---

async function spotifyToken() {
  const id = env('SPOTIFY_CLIENT_ID');
  const secret = env('SPOTIFY_CLIENT_SECRET');
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function checkSpotify(state) {
  const token = await spotifyToken();
  const url = `https://api.spotify.com/v1/artists/${cfg.spotifyArtistId}/albums?limit=20&include_groups=album,single&market=${cfg.market}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Spotify albums ${res.status}: ${await res.text()}`);

  const items = (await res.json()).items || [];
  const seen = new Set(state.spotify.lastAlbumIds);
  const isSeed = state.spotify.lastAlbumIds.length === 0;
  const newAlbums = [];

  for (const a of items) {
    if (seen.has(a.id)) continue;
    if (!isSeed) newAlbums.push(a);
    state.spotify.lastAlbumIds.push(a.id);
  }
  state.spotify.lastAlbumIds = state.spotify.lastAlbumIds.slice(-100);

  if (isSeed) {
    console.log(`[spotify] seeded ${items.length} releases (no posts on first run)`);
    return;
  }

  for (const a of newAlbums.reverse()) {
    const img = a.images?.[0]?.url;
    const isSingle = a.album_type === 'single';
    await discordPost(cfg.musicChannelId, {
      content: '🔥 New release from Chrissy Nightingale!',
      embed: {
        title: a.name,
        url: a.external_urls?.spotify || `https://open.spotify.com/album/${a.id}`,
        description: `${isSingle ? 'Single' : 'Album'} · ${a.total_tracks} track${a.total_tracks === 1 ? '' : 's'} · Released ${a.release_date}`,
        color: cfg.colors.spotify,
        image: img ? { url: img } : undefined,
        footer: { text: 'Spotify' },
      },
    });
    console.log(`[spotify] posted ${a.id}`);
  }
}

// ----------------------------------------------------------------- Twitch ---

async function twitchToken() {
  const id = env('TWITCH_CLIENT_ID');
  const secret = env('TWITCH_CLIENT_SECRET');
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `client_id=${id}&client_secret=${secret}&grant_type=client_credentials`,
  });
  if (!res.ok) throw new Error(`Twitch token ${res.status}: ${await res.text()}`);
  return { token: (await res.json()).access_token, clientId: id };
}

async function checkTwitch(state) {
  const { token, clientId } = await twitchToken();
  const res = await fetch(
    `https://api.twitch.tv/helix/streams?user_login=${cfg.twitchLogin}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Client-Id': clientId,
      },
    }
  );
  if (!res.ok) throw new Error(`Twitch streams ${res.status}: ${await res.text()}`);
  const live = ((await res.json()).data || [])[0];

  if (live && !state.twitch.isLive) {
    const thumb = (live.thumbnail_url || '')
      .replace('{width}', '1280')
      .replace('{height}', '720');
    await discordPost(cfg.twitchChannelId, {
      content: '🔴 Chrissy Nightingale is LIVE on Twitch!',
      embed: {
        title: live.title || 'Live now',
        url: `https://twitch.tv/${cfg.twitchLogin}`,
        description: live.game_name ? `Streaming **${live.game_name}**` : undefined,
        color: cfg.colors.twitch,
        image: thumb ? { url: `${thumb}?_=${Date.now()}` } : undefined,
        footer: { text: 'Twitch' },
      },
    });
    state.twitch.isLive = true;
    state.twitch.lastStreamId = live.id;
    console.log(`[twitch] posted live ${live.id}`);
  } else if (!live && state.twitch.isLive) {
    state.twitch.isLive = false;
    console.log('[twitch] stream ended');
  }
}

// ------------------------------------------------------------------- Main ---

async function main() {
  const state = await loadState();
  const tasks = [
    ['youtube', checkYouTube],
    ['spotify', checkSpotify],
    ['twitch', checkTwitch],
  ];

  let failures = 0;
  for (const [name, fn] of tasks) {
    try {
      await fn(state);
    } catch (e) {
      console.error(`[${name}] ${e.message}`);
      failures++;
    }
  }
  await saveState(state);

  // Don't fail the whole job for a single source hiccup; only fail if every
  // source died (likely a misconfigured secret).
  if (failures === tasks.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

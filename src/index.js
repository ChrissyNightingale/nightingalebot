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
  merchChannelId: '1511951314895241356',
  spotifyArtistId: '0eIGTeyCGI7ztWfLBd0v4Y',
  youtubeHandle: 'ChrissyNightingale',
  twitchLogin: 'chrissynightingale',
  merchSitemapUrl: 'https://chrissynightingale.com/sitemap.xml',
  market: 'US',
  // Color palette per source — Discord embed bar color.
  colors: {
    youtube: 0xFF0000,
    spotify: 0x1DB954,
    twitch: 0x9146FF,
    release: 0xFF3366,
    merch: 0xFFB400,
  },
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
  merch: { lastProductSlugs: [] },
};

async function loadState() {
  try {
    const s = JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
    // Migrate missing keys defensively.
    s.youtube ??= { channelId: null, lastVideoIds: [] };
    s.spotify ??= { lastAlbumIds: [] };
    s.twitch ??= { isLive: false, lastStreamId: null };
    s.merch ??= { lastProductSlugs: [] };
    s.youtube.lastVideoIds ??= [];
    s.spotify.lastAlbumIds ??= [];
    s.merch.lastProductSlugs ??= [];
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
  // Resolve channel ID once (cached in state). We don't actually use the RSS
  // feed — YouTube's /feeds/videos.xml endpoint started returning 404 in 2026
  // for arbitrary channels. Instead, scrape the /videos HTML page; the page
  // ships ytInitialData embedded as JSON which lists every upload with its
  // ID + title in newest-first order.
  await resolveYouTubeChannelId(state);

  const channelId = state.youtube.channelId;
  // Try @handle/videos first, then /channel/UC.../videos as a fallback. GH
  // Actions runner IPs are sometimes shown a different layout than logged-in
  // users, and one URL form may carry the data while the other doesn't.
  const urls = [
    `https://www.youtube.com/@${cfg.youtubeHandle}/videos`,
    `https://www.youtube.com/channel/${channelId}/videos`,
  ];
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    // CONSENT=YES+ skips YouTube's EU/datacenter consent interstitial that
    // otherwise replaces the page body with a consent gate.
    Cookie: 'CONSENT=YES+1; PREF=hl=en&gl=US',
  };

  let html = '';
  let lastErr = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) { lastErr = `HTTP ${r.status} on ${url}`; continue; }
      html = await r.text();
      // Quick sanity: must contain at least one videoId substring to be useful.
      if (/"videoId":"[A-Za-z0-9_-]{11}"/.test(html)) break;
      lastErr = `no videoId tokens on ${url} (size=${html.length})`;
      html = '';
    } catch (e) {
      lastErr = `${url}: ${e.message}`;
    }
  }
  if (!html) throw new Error(`YouTube scrape failed: ${lastErr}`);

  // Pass 1: pair videoId with title via videoRenderer / gridVideoRenderer
  // / richItemRenderer JSON blocks. Titles can come as runs[].text or
  // simpleText depending on layout.
  const items = [];
  const seenThisPass = new Set();
  const titleRe =
    /"(?:videoRenderer|gridVideoRenderer)":\{"videoId":"([A-Za-z0-9_-]{11})"[\s\S]{0,2000}?"title":\{(?:"runs":\[\{"text":"|"simpleText":")((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = titleRe.exec(html))) {
    const vid = m[1];
    if (seenThisPass.has(vid)) continue;
    seenThisPass.add(vid);
    const title = m[2]
      .replace(/\\u0026/g, '&')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    items.push({ vid, title });
  }

  // Pass 2 fallback: pick up any remaining videoIds we missed and look up
  // titles via oembed (1 cheap HTTP per missed video, rarely runs).
  const allIds = [...html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)]
    .map((x) => x[1])
    .filter((v, i, a) => a.indexOf(v) === i);
  for (const vid of allIds) {
    if (seenThisPass.has(vid)) continue;
    seenThisPass.add(vid);
    let title = vid;
    try {
      const oe = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${vid}&format=json`,
        { headers: { 'User-Agent': headers['User-Agent'] } }
      );
      if (oe.ok) {
        const j = await oe.json();
        if (j.title) title = j.title;
      }
    } catch { /* keep id as title fallback */ }
    items.push({ vid, title });
  }

  if (items.length === 0) {
    throw new Error(
      `YouTube scrape: 0 videos parsed (htmlSize=${html.length}, hasVideoId=${/"videoId":/.test(html)})`
    );
  }

  const seen = new Set(state.youtube.lastVideoIds);
  const isSeed = state.youtube.lastVideoIds.length === 0;
  const newItems = [];

  // items[0] is newest. On a seed run we record everything and skip posting;
  // on a normal run we only record IDs *after* a successful Discord post, so
  // that a transient Discord failure (e.g. permission glitch) leaves the item
  // eligible for retry on the next tick instead of silently swallowing it.
  for (const it of items) {
    if (seen.has(it.vid)) continue;
    if (isSeed) {
      state.youtube.lastVideoIds.push(it.vid);
    } else {
      newItems.push(it);
    }
  }
  state.youtube.lastVideoIds = state.youtube.lastVideoIds.slice(-50);

  if (isSeed) {
    console.log(`[youtube] seeded ${items.length} videos (no posts on first run)`);
    return;
  }

  // Post oldest -> newest so the Discord channel reads in publish order.
  // Record each ID only after the post succeeds.
  for (const v of newItems.reverse()) {
    await discordPost(cfg.musicChannelId, {
      content: '🎬 New video from Chrissy Nightingale!',
      embed: {
        title: v.title,
        url: `https://www.youtube.com/watch?v=${v.vid}`,
        color: cfg.colors.youtube,
        image: { url: `https://i.ytimg.com/vi/${v.vid}/hqdefault.jpg` },
        footer: { text: 'YouTube' },
      },
    });
    state.youtube.lastVideoIds.push(v.vid);
    console.log(`[youtube] posted ${v.vid}`);
  }
  state.youtube.lastVideoIds = state.youtube.lastVideoIds.slice(-50);
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
    if (isSeed) {
      state.spotify.lastAlbumIds.push(a.id);
    } else {
      newAlbums.push(a);
    }
  }
  state.spotify.lastAlbumIds = state.spotify.lastAlbumIds.slice(-100);

  if (isSeed) {
    console.log(`[spotify] seeded ${items.length} releases (no posts on first run)`);
    return;
  }

  // Only mark an ID as seen after the post lands, so a Discord hiccup doesn't
  // silently swallow the announcement.
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
    state.spotify.lastAlbumIds.push(a.id);
    console.log(`[spotify] posted ${a.id}`);
  }
  state.spotify.lastAlbumIds = state.spotify.lastAlbumIds.slice(-100);
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

// ------------------------------------------------------------------ Merch ---

// Fetch the storefront sitemap and extract every /products/<slug> URL. The
// sitemap is gzip-encoded by Fourthwall; Node's fetch auto-decompresses when
// Accept-Encoding negotiation succeeds.
async function fetchProductSlugs() {
  const res = await fetch(cfg.merchSitemapUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 NightingaleBot',
      'Accept-Encoding': 'gzip, deflate',
    },
  });
  if (!res.ok) throw new Error(`merch sitemap ${res.status}`);
  const xml = await res.text();
  const slugs = [
    ...xml.matchAll(/<loc>https:\/\/chrissynightingale\.com\/products\/([^<]+)<\/loc>/g),
  ].map((m) => m[1]);
  // Preserve order of appearance; sitemap puts newest products near the top.
  return [...new Set(slugs)];
}

async function fetchProductMeta(slug) {
  const url = `https://chrissynightingale.com/products/${slug}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 NightingaleBot' },
  });
  if (!res.ok) return { url, title: slug, image: null, description: null };
  const html = await res.text();
  const pick = (re) => {
    const m = html.match(re);
    return m ? m[1] : null;
  };
  const decode = (s) =>
    s
      ?.replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'") || null;
  const title =
    decode(pick(/<meta\s+property="og:title"\s+content="([^"]+)"/)) || slug;
  const image = pick(/<meta\s+property="og:image"\s+content="([^"]+)"/);
  const description = decode(
    pick(/<meta\s+property="og:description"\s+content="([^"]+)"/)
  );
  const price =
    pick(/<meta\s+property="(?:product:price:amount|og:price:amount)"\s+content="([^"]+)"/);
  const currency =
    pick(
      /<meta\s+property="(?:product:price:currency|og:price:currency)"\s+content="([^"]+)"/
    ) || 'USD';
  return { url, title, image, description, price, currency };
}

async function checkMerch(state) {
  const slugs = await fetchProductSlugs();
  if (slugs.length === 0) throw new Error('merch sitemap: no products parsed');

  const seen = new Set(state.merch.lastProductSlugs);
  const isSeed = state.merch.lastProductSlugs.length === 0;
  const fresh = [];

  for (const slug of slugs) {
    if (seen.has(slug)) continue;
    if (isSeed) {
      state.merch.lastProductSlugs.push(slug);
    } else {
      fresh.push(slug);
    }
  }
  state.merch.lastProductSlugs = state.merch.lastProductSlugs.slice(-200);

  if (isSeed) {
    console.log(`[merch] seeded ${slugs.length} products (no posts on first run)`);
    return;
  }

  // Post oldest first so they read in append order.
  for (const slug of fresh.reverse()) {
    const meta = await fetchProductMeta(slug);
    const priceLine =
      meta.price ? `**$${meta.price}** ${meta.currency}` : null;
    await discordPost(cfg.merchChannelId, {
      content: '🛍️ New merch from Chrissy Nightingale!',
      embed: {
        title: meta.title,
        url: meta.url,
        description: [priceLine, meta.description].filter(Boolean).join('\n\n') || undefined,
        color: cfg.colors.merch,
        image: meta.image ? { url: meta.image } : undefined,
        footer: { text: 'chrissynightingale.com' },
      },
    });
    state.merch.lastProductSlugs.push(slug);
    console.log(`[merch] posted ${slug}`);
  }
  state.merch.lastProductSlugs = state.merch.lastProductSlugs.slice(-200);
}

// ------------------------------------------------------------------- Main ---

async function postAllCurrentMerch() {
  const slugs = await fetchProductSlugs();
  // Post in storefront display order: sitemap lists newest first; flip so the
  // channel reads chronologically (oldest → newest) the way a feed scrolls.
  for (const slug of slugs.slice().reverse()) {
    const meta = await fetchProductMeta(slug);
    const priceLine = meta.price ? `**$${meta.price}** ${meta.currency}` : null;
    await discordPost(cfg.merchChannelId, {
      content: `🛍️ **[${meta.title}](${meta.url})**`,
      embed: {
        url: meta.url,
        description: priceLine || undefined,
        color: cfg.colors.merch,
        image: meta.image ? { url: meta.image } : undefined,
        footer: { text: 'chrissynightingale.com' },
      },
    });
    console.log(`[merch:bulk] posted ${slug}`);
    // Stay well under Discord's per-channel rate limit (5 msg / 5 sec).
    await new Promise((r) => setTimeout(r, 600));
  }
}

async function simulateTwitchLive() {
  await discordPost(cfg.twitchChannelId, {
    content: '🔴 Chrissy Nightingale is LIVE on Twitch! _(simulation)_',
    embed: {
      title: '[TEST] Simulated stream — wiring check',
      url: `https://twitch.tv/${cfg.twitchLogin}`,
      description: 'Streaming **Just Chatting** _(simulation — not actually live)_',
      color: cfg.colors.twitch,
      footer: { text: 'Twitch · simulation' },
    },
  });
  console.log('[twitch] simulation posted');
}

async function main() {
  // One-off simulation path: workflow_dispatch can flip this to verify the
  // Twitch posting path lands without waiting for a real stream.
  if (process.env.SIMULATE_TWITCH === '1') {
    await simulateTwitchLive();
    return;
  }

  // One-off backfill: post every current product on the storefront to the
  // merch channel. Bypasses state (does not record posted slugs).
  if (process.env.POST_ALL_MERCH === '1') {
    await postAllCurrentMerch();
    return;
  }

  const state = await loadState();
  const tasks = [
    ['youtube', checkYouTube],
    ['spotify', checkSpotify],
    ['twitch', checkTwitch],
    ['merch', checkMerch],
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

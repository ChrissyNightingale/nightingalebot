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
  welcomeChannelId: '1476195654761189489',
  reactionRolesChannelId: '1476730021837144124',
  generalChannelId: '1475433666682290240',
  rulesChannelId: '1476202330222231675',
  verifiedRoleId: '1476268190454513898',
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
  // Role IDs to ping per event type. Roles are non-mentionable in the guild,
  // but allowed_mentions.roles bypasses that for the bot. If pings don't land,
  // grant the NightingaleBot role the "Mention @everyone, @here, and All Roles"
  // permission in the guild.
  roles: {
    announcements: '1507600835146682439',
    livestreams: '1507600833645121606',
    youtube: '1508008798927847425',
    productUpdates: '1507600825688527019',
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
  verified: { knownMemberIds: [] },
  joins: { knownMemberIds: [] },
  rules: { messageId: null },
};

async function loadState() {
  try {
    const s = JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
    // Migrate missing keys defensively.
    s.youtube ??= { channelId: null, lastVideoIds: [] };
    s.spotify ??= { lastAlbumIds: [] };
    s.twitch ??= { isLive: false, lastStreamId: null };
    s.merch ??= { lastProductSlugs: [] };
    s.verified ??= { knownMemberIds: [] };
    s.joins ??= { knownMemberIds: [] };
    s.rules ??= { messageId: null };
    s.youtube.lastVideoIds ??= [];
    s.spotify.lastAlbumIds ??= [];
    s.merch.lastProductSlugs ??= [];
    s.verified.knownMemberIds ??= [];
    s.joins.knownMemberIds ??= [];
    return s;
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

async function saveState(s) {
  await fs.writeFile(STATE_PATH, JSON.stringify(s, null, 2) + '\n');
}

// ---------------------------------------------------------------- Discord ---

async function discordPost(
  channelId,
  {
    content,
    embed,
    mentionEveryone = false,
    mentionRoles = [],
    mentionUsers = [],
  }
) {
  const token = env('NIGHTINGALE_DISCORD_BOT_TOKEN');
  // Prepend role pings to the message body so the role rendering sits above
  // the embed. allowed_mentions.roles lets the bot ping even non-mentionable
  // roles without unlocking them for regular users.
  const rolePrefix = mentionRoles.map((id) => `<@&${id}>`).join(' ');
  let body_content = content || '';
  if (rolePrefix) body_content = `${rolePrefix}${body_content ? ' ' + body_content : ''}`;
  if (mentionEveryone) body_content = `@everyone${body_content ? '\n' + body_content : ''}`;

  const allowed_mentions = { parse: [] };
  if (mentionEveryone) allowed_mentions.parse = ['everyone'];
  if (mentionRoles.length) allowed_mentions.roles = mentionRoles;
  if (mentionUsers.length) allowed_mentions.users = mentionUsers;

  const body = { content: body_content, allowed_mentions };
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
      mentionRoles: [cfg.roles.youtube],
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
      mentionRoles: [cfg.roles.announcements],
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
      mentionRoles: [cfg.roles.livestreams],
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

// ---------------------------------------------------------- Members API ---

async function fetchGuildName() {
  const token = env('NIGHTINGALE_DISCORD_BOT_TOKEN');
  const res = await fetch(`https://discord.com/api/v10/guilds/${cfg.guildId}`, {
    headers: {
      Authorization: `Bot ${token}`,
      'User-Agent': 'NightingaleBot (+https://chrissynightingale.com)',
    },
  });
  if (!res.ok) throw new Error(`Discord guild ${res.status}: ${await res.text()}`);
  return (await res.json()).name;
}

// Pull every guild member, paginating through /members (max 1000 per page).
async function fetchAllGuildMembers() {
  const token = env('NIGHTINGALE_DISCORD_BOT_TOKEN');
  const out = [];
  let after = '0';
  for (let page = 0; page < 100; page++) {
    const res = await fetch(
      `https://discord.com/api/v10/guilds/${cfg.guildId}/members?limit=1000&after=${after}`,
      {
        headers: {
          Authorization: `Bot ${token}`,
          'User-Agent': 'NightingaleBot (+https://chrissynightingale.com)',
        },
      }
    );
    if (!res.ok) {
      const txt = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Discord members ${res.status} — likely missing "Server Members Intent". ${txt}`
        );
      }
      throw new Error(`Discord members ${res.status}: ${txt}`);
    }
    const batch = await res.json();
    if (!batch.length) break;
    out.push(...batch);
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }
  return out;
}

async function checkVerifiedWelcome(state) {
  const members = await fetchAllGuildMembers();
  // Filter to members that currently have the @Verified role and are not bots.
  const verifiedIds = members
    .filter((m) => !m.user.bot && (m.roles || []).includes(cfg.verifiedRoleId))
    .map((m) => m.user.id);

  const known = new Set(state.verified.knownMemberIds);
  const isSeed = state.verified.knownMemberIds.length === 0;
  const newly = verifiedIds.filter((id) => !known.has(id));

  // Refresh known set to the current snapshot — handles role losses cleanly
  // (a user who lost @Verified and re-earns it gets a fresh welcome).
  state.verified.knownMemberIds = verifiedIds;

  if (isSeed) {
    console.log(
      `[verified] seeded ${verifiedIds.length} currently-verified members (no welcomes on first run)`
    );
    return;
  }

  for (const userId of newly) {
    await discordPost(cfg.welcomeChannelId, {
      content:
        `Hey <@${userId}>, consider visiting <#${cfg.reactionRolesChannelId}> ` +
        `and introduce yourself in <#${cfg.generalChannelId}>!`,
      mentionUsers: [userId],
    });
    console.log(`[verified] welcomed ${userId}`);
  }
}

// ------------------------------------------------------- Rules & verify ---

const RULES_EMOJI = '✅';

function buildRulesBody(guildName) {
  return [
    `📜 **Server Rules**`,
    `Welcome to **${guildName}**! Read these, then react with ${RULES_EMOJI} to verify and gain access to the rest of the server.`,
    ``,
    `🤝 **1. Be cool, kind, and respectful**`,
    `Treat everyone the way you'd want to be treated. Constructive disagreement is fine — personal attacks are not.`,
    ``,
    `👤 **2. Keep your Discord profile appropriate**`,
    `Display name, avatar, and bio must be SFW and non-offensive. No impersonation.`,
    ``,
    `🚯 **3. Do not spam**`,
    `No wall-of-text, excessive caps, mass mentions, copy-paste, or unsolicited DMs.`,
    ``,
    `🛡️ **4. No personal information**`,
    `Yours or anyone else's. Don't share addresses, phone numbers, emails, or private screenshots.`,
    ``,
    `🫶 **5. No homophobia, transphobia, or hate speech**`,
    `Includes racism, sexism, ableism, or slurs of any kind. Zero tolerance.`,
    ``,
    `🕊️ **6. No political or religious topics**`,
    `Keep the lane musical and chill.`,
    ``,
    `🔞 **7. No piracy, sexual, NSFW, or otherwise suspicious content**`,
    `No porn, gore, leaked content, illegal downloads, scams, or anything that violates Discord's TOS.`,
    ``,
    `🧠 **8. Rules are subject to common sense**`,
    `If it feels off, it probably is. Mods have final say. Rules may be updated at any time.`,
    ``,
    `${RULES_EMOJI} **React below with the green checkmark** to confirm you've read & agree to these rules. You'll instantly gain the **@Verified** role and full server access.`,
  ].join('\n');
}

async function postRulesMessage(state) {
  const token = env('NIGHTINGALE_DISCORD_BOT_TOKEN');
  const guildName = await fetchGuildName();
  const content = buildRulesBody(guildName);

  const postRes = await fetch(
    `https://discord.com/api/v10/channels/${cfg.rulesChannelId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'NightingaleBot (+https://chrissynightingale.com)',
      },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    }
  );
  if (!postRes.ok) {
    throw new Error(`rules post ${postRes.status}: ${await postRes.text()}`);
  }
  const msg = await postRes.json();

  // Seed the green checkmark reaction so members can click rather than type.
  const reactRes = await fetch(
    `https://discord.com/api/v10/channels/${cfg.rulesChannelId}/messages/${msg.id}/reactions/${encodeURIComponent(RULES_EMOJI)}/@me`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent': 'NightingaleBot (+https://chrissynightingale.com)',
      },
    }
  );
  if (!reactRes.ok) {
    console.warn(
      `[rules] could not seed reaction (${reactRes.status}): ${await reactRes.text()}`
    );
  }

  state.rules.messageId = msg.id;
  console.log(`[rules] posted message ${msg.id}`);
}

async function fetchReactionUsers(channelId, messageId, emoji) {
  const token = env('NIGHTINGALE_DISCORD_BOT_TOKEN');
  const users = [];
  let after = '0';
  for (let page = 0; page < 50; page++) {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?limit=100&after=${after}`,
      {
        headers: {
          Authorization: `Bot ${token}`,
          'User-Agent': 'NightingaleBot (+https://chrissynightingale.com)',
        },
      }
    );
    if (!res.ok) throw new Error(`reactions ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    if (!batch.length) break;
    users.push(...batch);
    if (batch.length < 100) break;
    after = batch[batch.length - 1].id;
  }
  return users;
}

async function grantVerifiedRole(userId) {
  const token = env('NIGHTINGALE_DISCORD_BOT_TOKEN');
  const res = await fetch(
    `https://discord.com/api/v10/guilds/${cfg.guildId}/members/${userId}/roles/${cfg.verifiedRoleId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent': 'NightingaleBot (+https://chrissynightingale.com)',
      },
    }
  );
  // 204 success; 403 = bot lacks Manage Roles or sits below @Verified.
  return res.status;
}

async function checkRulesReactions(state) {
  if (!state.rules.messageId) {
    console.log('[rules] no rules message recorded — run post_rules first');
    return;
  }

  let reactors;
  try {
    reactors = await fetchReactionUsers(
      cfg.rulesChannelId,
      state.rules.messageId,
      RULES_EMOJI
    );
  } catch (e) {
    // If the rules message was deleted, drop the pointer so a future post_rules
    // run can replace it.
    if (/40[34]/.test(e.message)) {
      console.warn(`[rules] message gone (${e.message}) — clearing state`);
      state.rules.messageId = null;
      return;
    }
    throw e;
  }

  const verified = new Set(state.verified.knownMemberIds);
  let granted = 0;
  for (const u of reactors) {
    if (u.bot || u.id === state.botId) continue;
    if (verified.has(u.id)) continue;
    const status = await grantVerifiedRole(u.id);
    if (status === 204) {
      console.log(`[rules] granted @Verified to ${u.username || u.id}`);
      granted++;
    } else if (status === 403) {
      console.error(
        `[rules] 403 granting ${u.id} — bot needs Manage Roles and a role above @Verified`
      );
    } else {
      console.log(`[rules] grant ${u.id} -> HTTP ${status}`);
    }
  }
  if (granted) {
    console.log(`[rules] total grants this tick: ${granted}`);
  }
}

// --------------------------------------------------------- Join welcome ---

async function checkJoinWelcome(state) {
  const members = await fetchAllGuildMembers();
  const guildName = await fetchGuildName();
  const ids = members.filter((m) => !m.user.bot).map((m) => m.user.id);

  const known = new Set(state.joins.knownMemberIds);
  const isSeed = state.joins.knownMemberIds.length === 0;
  const newJoins = ids.filter((id) => !known.has(id));

  // Snapshot current roster — drops anyone who left, so a rejoin gets a
  // fresh welcome.
  state.joins.knownMemberIds = ids;

  if (isSeed) {
    console.log(
      `[joins] seeded ${ids.length} members (no welcomes on first run)`
    );
    return;
  }

  for (const userId of newJoins) {
    await discordPost(cfg.welcomeChannelId, {
      content:
        `Hey <@${userId}>, welcome to **${guildName}**! ` +
        `Please visit <#${cfg.rulesChannelId}> to verify and gain access ` +
        `to the rest of the server!`,
      mentionUsers: [userId],
    });
    console.log(`[joins] welcomed ${userId}`);
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
      mentionRoles: [cfg.roles.productUpdates],
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

async function listGuildEmojis() {
  const token = env('NIGHTINGALE_DISCORD_BOT_TOKEN');
  const res = await fetch(
    `https://discord.com/api/v10/guilds/${cfg.guildId}/emojis`,
    {
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent': 'NightingaleBot (+https://chrissynightingale.com)',
      },
    }
  );
  if (!res.ok) throw new Error(`Discord emojis ${res.status}: ${await res.text()}`);
  const emojis = await res.json();
  for (const e of emojis) {
    console.log(`[emoji] ${e.id}  :${e.name}:  animated=${!!e.animated}`);
  }
}

async function listGuildChannels() {
  const token = env('NIGHTINGALE_DISCORD_BOT_TOKEN');
  const res = await fetch(
    `https://discord.com/api/v10/guilds/${cfg.guildId}/channels`,
    {
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent': 'NightingaleBot (+https://chrissynightingale.com)',
      },
    }
  );
  if (!res.ok) throw new Error(`Discord channels ${res.status}: ${await res.text()}`);
  const channels = await res.json();
  for (const c of channels) {
    console.log(`[channel] ${c.id}  type=${c.type}  ${c.name}`);
  }
}

async function listGuildRoles() {
  const token = env('NIGHTINGALE_DISCORD_BOT_TOKEN');
  const res = await fetch(
    `https://discord.com/api/v10/guilds/${cfg.guildId}/roles`,
    {
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent': 'NightingaleBot (+https://chrissynightingale.com)',
      },
    }
  );
  if (!res.ok) throw new Error(`Discord roles ${res.status}: ${await res.text()}`);
  const roles = await res.json();
  for (const r of roles) {
    console.log(`[role] ${r.id}  ${r.name}  mentionable=${r.mentionable}`);
  }
}

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

async function simulateJoinWelcome(username) {
  const token = env('NIGHTINGALE_DISCORD_BOT_TOKEN');
  const res = await fetch(
    `https://discord.com/api/v10/guilds/${cfg.guildId}/members/search?query=${encodeURIComponent(username)}&limit=10`,
    {
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent': 'NightingaleBot (+https://chrissynightingale.com)',
      },
    }
  );
  if (!res.ok) throw new Error(`member search ${res.status}: ${await res.text()}`);
  const hits = await res.json();
  if (!hits.length) throw new Error(`no member matched "${username}"`);
  const target = hits[0];
  const guildName = await fetchGuildName();
  await discordPost(cfg.welcomeChannelId, {
    content:
      `Hey <@${target.user.id}>, welcome to **${guildName}**! ` +
      `Please visit <#${cfg.rulesChannelId}> to verify and gain access ` +
      `to the rest of the server!`,
    mentionUsers: [target.user.id],
  });
  console.log(
    `[joins:sim] welcomed ${target.user.username} (${target.user.id})`
  );
}

async function simulateTwitchLive() {
  await discordPost(cfg.twitchChannelId, {
    content: '🔴 Chrissy Nightingale is LIVE on Twitch! _(simulation)_',
    mentionRoles: [cfg.roles.livestreams],
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

  // One-off: fire the join-welcome message at a specific user by username.
  if (process.env.WELCOME_USER) {
    await simulateJoinWelcome(process.env.WELCOME_USER);
    return;
  }

  // One-off: post (or re-post) the server rules to the rules channel with the
  // green-checkmark reaction pre-seeded. Stores the new message ID so the
  // reaction-role grant path can monitor it.
  if (process.env.POST_RULES === '1') {
    const s = await loadState();
    await postRulesMessage(s);
    await saveState(s);
    return;
  }

  // One-off: dump every guild role + ID + mentionable flag to logs.
  if (process.env.LIST_ROLES === '1') {
    await listGuildRoles();
    return;
  }

  // One-off: dump every guild channel + ID + type to logs.
  if (process.env.LIST_CHANNELS === '1') {
    await listGuildChannels();
    return;
  }

  // One-off: dump every custom emoji + ID + name to logs.
  if (process.env.LIST_EMOJIS === '1') {
    await listGuildEmojis();
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
    ['joins', checkJoinWelcome],
    // Grant @Verified to anyone who reacted to the rules before the verified
    // check runs, so newly-granted members get welcomed in the same tick.
    ['rules', checkRulesReactions],
    ['verified', checkVerifiedWelcome],
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

// Weekly stream-schedule poster. Computes this week's Tue–Fri 9:00 AM PT
// instants, renders them as Discord dynamic timestamps (each viewer sees the
// time in their OWN locale/zone), and posts to the schedule channel as
// NightingaleBot. Run weekly by .github/workflows/stream-schedule.yml.
//
// Env:
//   NIGHTINGALE_DISCORD_BOT_TOKEN  (required)
//   SCHEDULE_CHANNEL_ID  default 1476195529129066721 (#music&videos)
//   LIVESTREAM_ROLE_ID   default 1507600833645121606; set empty to skip ping

const TOKEN = process.env.NIGHTINGALE_DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error('Missing NIGHTINGALE_DISCORD_BOT_TOKEN');
  process.exit(1);
}
const CHANNEL = process.env.SCHEDULE_CHANNEL_ID || '1476195529129066721';
const ROLE = process.env.LIVESTREAM_ROLE_ID ?? '1507600833645121606';
const REACTION_ROLES = process.env.REACTION_ROLES_CHANNEL_ID || '1476730021837144124';
const MODE = process.env.SCHEDULE_MODE || 'post';

function discord(path, init = {}) {
  return fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'nightingalebot-schedule (+https://chrissynightingale.com)',
      ...(init.headers || {}),
    },
  });
}

// Cleanup mode: delete this bot's own prior schedule posts from the channel.
// A bot can delete its own messages without Manage Messages. Scoped tightly to
// messages it authored whose body carries the schedule header.
if (MODE === 'delete') {
  const me = await (await discord('/users/@me')).json();
  const listRes = await discord(`/channels/${CHANNEL}/messages?limit=30`);
  if (!listRes.ok) {
    console.error(`list ${listRes.status}: ${await listRes.text()}`);
    process.exit(1);
  }
  const mine = (await listRes.json()).filter(
    (m) => m.author?.id === me.id && /WEEKLY STREAM SCHEDULE/.test(m.content || '')
  );
  let n = 0;
  for (const m of mine) {
    const del = await discord(`/channels/${CHANNEL}/messages/${m.id}`, { method: 'DELETE' });
    if (del.ok || del.status === 204) n++;
    else console.error(`delete ${m.id} -> ${del.status}: ${await del.text()}`);
    await new Promise((r) => setTimeout(r, 400)); // ease off the rate limiter
  }
  console.log(`deleted ${n} schedule post(s) from ${CHANNEL}`);
  process.exit(0);
}

// America/Los_Angeles UTC offset (ms) at a given instant — DST-aware via Intl.
function laOffsetMs(date) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(date)
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

// Unix seconds for wall-clock Y/M/D H:00 in Pacific time. 9am never straddles
// the 2am DST flip, so a single offset correction is exact.
function ptUnix(y, m, d, h) {
  const guess = Date.UTC(y, m - 1, d, h, 0, 0);
  const off = laOffsetMs(new Date(guess));
  return Math.floor((guess - off) / 1000);
}

// Today's calendar date as seen in Pacific time.
function ptToday() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(new Date())
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  return { y: +p.year, m: +p.month, d: +p.day };
}

// Anchor at noon (avoids any day-rollover) of today's PT date, then walk to
// this ISO week's Tue(2)..Fri(5). getUTCDay: 0=Sun..6=Sat.
const t = ptToday();
const anchor = new Date(Date.UTC(t.y, t.m - 1, t.d, 12));
const dow = anchor.getUTCDay();
const labels = ['Tue', 'Wed', 'Thu', 'Fri'];
const days = [2, 3, 4, 5].map((td) => {
  const dt = new Date(anchor.getTime() + (td - dow) * 86_400_000);
  return ptUnix(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), 9);
});

const ts = (u, f) => `<t:${u}:${f}>`;
const content = [
  ROLE ? `<@&${ROLE}>` : null,
  `# 🚀🔥 WEEKLY STREAM SCHEDULE 🔥🚀`,
  ``,
  `**Live in the 'verse all week — Star Citizen + music.**`,
  ``,
  ...days.map((u, i) => `🟣 **${labels[i]}** — ${ts(u, 'F')}`),
  `⏱️ each stream runs **5–10 hrs** · first one ${ts(days[0], 'R')}`,
  ``,
  `🎮 **Star Citizen** — fleet ops, missions, chaos`,
  `🎶 mid-stream music break — **3 songs, viewer's choice** 🔥`,
  `📺 **twitch.tv/chrissynightingale** — follow to catch go-live`,
  `🔔 grab the **Livestreams** role in <#${REACTION_ROLES}> for live pings`,
  ``,
  `See you in the black. o7`,
]
  .filter((x) => x !== null)
  .join('\n');

const res = await discord(`/channels/${CHANNEL}/messages`, {
  method: 'POST',
  body: JSON.stringify({
    content,
    allowed_mentions: ROLE ? { roles: [ROLE] } : { parse: [] },
  }),
});

if (!res.ok) {
  console.error(`Discord ${res.status}: ${await res.text()}`);
  process.exit(1);
}
console.log(`posted weekly schedule to ${CHANNEL}`);

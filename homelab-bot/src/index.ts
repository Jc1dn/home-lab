import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
  ContainerBuilder,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type Message,
  type TextChannel,
} from 'discord.js';
import { Client as SshClient } from 'ssh2';
import fs from 'fs';
import os from 'os';
import path from 'path';
import 'dotenv/config';

/* ══════════════════════════════════════════════════════════════════════
   CONFIG
   ══════════════════════════════════════════════════════════════════════ */

const COLORS = {
  neutral: 0x2b2d31,
  success: 0x57f287,
  danger: 0xed4245,
  warn: 0xfaa61a,
  proxmox: 0xe57000,
} as const;

const TRACKER_INTERVAL_MS = 10_000;
const MAX_STREAMS_PER_MESSAGE = 9;
const MAX_FILES_PER_MESSAGE = 10;
const STATS_TTL_MS = 5 * 60 * 1000;
const TRACKER_STATE_FILE = path.join(process.cwd(), '.tracker-state.json');

/* Logo (author icon) */
const LOGO_PATH = path.join(process.cwd(), 'assets', 'jellyfin-logo.png');
const LOGO_ATTACHMENT_NAME = 'jellyfin-logo.png';
let logoBuffer: Buffer | null = null;
try {
  logoBuffer = fs.readFileSync(LOGO_PATH);
  console.log(`[Jellyfin] Loaded logo (${logoBuffer.length} bytes) from ${LOGO_PATH}`);
} catch {
  console.warn(`[Jellyfin] Logo not found at ${LOGO_PATH} — embeds will render without an icon`);
}

function logoAttachment(): AttachmentBuilder | null {
  return logoBuffer ? new AttachmentBuilder(logoBuffer, { name: LOGO_ATTACHMENT_NAME }) : null;
}

/* ANSI helpers */
const A = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  gray: '\u001b[2;37m',
  white: '\u001b[1;37m',
  green: '\u001b[1;32m',
  yellow: '\u001b[1;33m',
  cyan: '\u001b[1;36m',
  red: '\u001b[1;31m',
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* ══════════════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════════════ */

function getJellyfinBaseUrl(): string {
  const configured = process.env.JELLYFIN_IP?.trim();
  if (!configured) throw new Error('JELLYFIN_IP is not configured.');
  const withProtocol = /^https?:\/\//i.test(configured) ? configured : `http://${configured}`;
  return new URL(withProtocol).toString().replace(/\/$/, '');
}

function jellyfinHeaders(): Record<string, string> {
  return { 'X-Emby-Authorization': `MediaBrowser Token="${process.env.JELLYFIN_API_KEY ?? ''}"` };
}

function withApiKey(url: string): string {
  const key = process.env.JELLYFIN_API_KEY;
  if (!key) return url;
  return `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`;
}

function createProgressBar(percent: number, length = 14): string {
  const safe = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const filled = Math.round((safe / 100) * length);
  return '▰'.repeat(filled) + '▱'.repeat(Math.max(0, length - filled));
}

function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function truncate(text: string, max: number): string {
  const clean = (text ?? '').toString().trim() || '(no output)';
  return clean.length <= max ? clean : `…\n${clean.slice(-max)}`;
}

function codeBlock(content: string, language = 'bash', max = 3800): string {
  return `\`\`\`${language}\n${truncate(content, max)}\n\`\`\``;
}

/* ══════════════════════════════════════════════════════════════════════
   SSH
   ══════════════════════════════════════════════════════════════════════ */

async function executeSsh(command: string): Promise<string> {
  let configuredKeyPath = process.env.PROXMOX_SSH_KEY?.trim();
  if (!configuredKeyPath && !process.env.SSH_AUTH_SOCK) configuredKeyPath = '~/.ssh/id_rsa';

  const keyPath = configuredKeyPath?.startsWith('~/')
    ? path.join(os.homedir(), configuredKeyPath.slice(2))
    : configuredKeyPath;

  const sshAgent = process.env.SSH_AUTH_SOCK;

  if (keyPath && !fs.existsSync(keyPath)) {
    throw new Error(`SSH key not found at ${keyPath}. Check your keys or set PROXMOX_SSH_KEY in .env.`);
  }

  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    let output = '';

    conn
      .on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          stream.on('data', (d: Buffer) => (output += d.toString()));
          stream.stderr.on('data', (d: Buffer) => (output += d.toString()));
          stream.on('close', (code: number) => {
            conn.end();
            if (code !== 0) reject(new Error(`Command failed (exit ${code}):\n${output}`));
            else resolve(output);
          });
        });
      })
      .on('error', reject)
      .connect({
        host: process.env.PROXMOX_IP as string,
        port: 22,
        username: 'root',
        ...(keyPath
          ? {
              privateKey: fs.readFileSync(keyPath),
              ...(process.env.PROXMOX_SSH_PASSPHRASE ? { passphrase: process.env.PROXMOX_SSH_PASSPHRASE } : {}),
            }
          : { agent: sshAgent! }),
      });
  });
}

const lxcCache = new Map<string, { name: string; status: string; node?: string }>();

/* ══════════════════════════════════════════════════════════════════════
   JELLYFIN — IMAGE FETCHING
   ══════════════════════════════════════════════════════════════════════ */

interface FetchedImage {
  buffer: Buffer;
  ext: string;
  name: string;
}

async function fetchJellyfinImage(
  url: string,
  label: string,
  fileName: string,
): Promise<FetchedImage | null> {
  try {
    const res = await fetch(withApiKey(url), { headers: jellyfinHeaders() });
    if (!res.ok) {
      console.warn(`[Image] ${label} → HTTP ${res.status} ${res.statusText}`);
      return null;
    }
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    const ext = ct.includes('png')
      ? 'png'
      : ct.includes('webp')
        ? 'webp'
        : ct.includes('gif')
          ? 'gif'
          : ct.includes('jpeg') || ct.includes('jpg')
            ? 'jpg'
            : 'png';
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) {
      console.warn(`[Image] ${label} → empty body`);
      return null;
    }
    return { buffer, ext, name: `${fileName}.${ext}` };
  } catch (err) {
    console.warn(`[Image] ${label} → fetch error:`, err);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   JELLYFIN — LIBRARY STATS
   ══════════════════════════════════════════════════════════════════════ */

interface LibraryStats {
  movies: number;
  series: number;
  episodes: number;
  users: number;
  version: string;
}

let statsCache: { data: LibraryStats; fetchedAt: number } | null = null;

async function getLibraryStats(baseUrl: string): Promise<LibraryStats | null> {
  if (statsCache && Date.now() - statsCache.fetchedAt < STATS_TTL_MS) return statsCache.data;
  try {
    const [countsRes, usersRes, infoRes] = await Promise.all([
      fetch(`${baseUrl}/Items/Counts`, { headers: jellyfinHeaders() }),
      fetch(`${baseUrl}/Users`, { headers: jellyfinHeaders() }),
      fetch(`${baseUrl}/System/Info`, { headers: jellyfinHeaders() }),
    ]);

    const counts = countsRes.ok ? await countsRes.json() : {};
    const users = usersRes.ok ? await usersRes.json() : [];
    const info = infoRes.ok ? await infoRes.json() : {};

    const data: LibraryStats = {
      movies: Number(counts?.MovieCount ?? 0),
      series: Number(counts?.SeriesCount ?? 0),
      episodes: Number(counts?.EpisodeCount ?? 0),
      users: Array.isArray(users) ? users.length : 0,
      version: String(info?.Version ?? '?').split('.')[0] || '?',
    };
    statsCache = { data, fetchedAt: Date.now() };
    return data;
  } catch (err) {
    console.warn('[Stats] fetch failed:', err);
    return statsCache?.data ?? null;
  }
}

function buildStatsBlock(stats: LibraryStats | null, activeCount: number): string {
  const line = (label: string, value: string | number, color = A.green) =>
    `${A.gray}${label.padEnd(16, ' ')}${A.reset}${color}${String(value).padStart(6, ' ')}${A.reset}`;

  const rows = stats
    ? [
        line('Movies', stats.movies),
        line('Series', stats.series),
        line('Episodes', stats.episodes),
        `${A.dim}─────────────────────────${A.reset}`,
        line('Users', stats.users, A.cyan),
        line('Active Sessions', activeCount, activeCount > 0 ? A.yellow : A.gray),
        line('Jellyfin Version', stats.version, A.white),
      ]
    : [line('Active Sessions', activeCount, activeCount > 0 ? A.yellow : A.gray)];

  return ['```ansi', ...rows, '```'].join('\n');
}

/* ══════════════════════════════════════════════════════════════════════
   JELLYFIN — TRACKER (COMPONENTS V2)
   ══════════════════════════════════════════════════════════════════════ */

interface TrackerEntry {
  message: Message;
  timer: NodeJS.Timeout;
}
const trackers = new Map<string, TrackerEntry>();

function readTrackerState(): { channelId: string; messageId: string }[] {
  try {
    return JSON.parse(fs.readFileSync(TRACKER_STATE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function persistTrackerState(): void {
  const state = [...trackers.entries()].map(([channelId, t]) => ({
    channelId,
    messageId: t.message.id,
  }));
  try {
    fs.writeFileSync(TRACKER_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('[Tracker] Could not persist state:', err);
  }
}

interface TrackerPayload {
  components: ContainerBuilder[];
  files: AttachmentBuilder[];
  flags: number;
}

async function buildTrackerComponents(baseUrl: string): Promise<TrackerPayload> {
  const [sessionsRes, stats] = await Promise.all([
    fetch(`${baseUrl}/Sessions`, { headers: jellyfinHeaders() }),
    getLibraryStats(baseUrl),
  ]);
  if (!sessionsRes.ok) throw new Error(`Jellyfin returned HTTP ${sessionsRes.status}`);
  const sessions: any[] = await sessionsRes.json();
  const active = sessions.filter((s) => s?.NowPlayingItem);
  const visible = active.slice(0, MAX_STREAMS_PER_MESSAGE);

  const files: AttachmentBuilder[] = [];
  const usedNames = new Set<string>();

  /* ── Fetch posters ───────────────────────────────────────────── */
  const posterRefs = new Map<number, string>();

  await Promise.all(
    visible.map(async (session, i) => {
      const item = session.NowPlayingItem;
      const id = item.Type === 'Episode' && item.SeriesId ? item.SeriesId : item.Id;
      if (!id) return;
      const img = await fetchJellyfinImage(
        `${baseUrl}/Items/${id}/Images/Primary`,
        `poster[${i}] ${id}`,
        `poster_${id}`,
      );
      if (!img) return;
      posterRefs.set(i, `attachment://${img.name}`);
      if (usedNames.has(img.name)) return;
      if (files.length >= MAX_FILES_PER_MESSAGE) return;
      files.push(new AttachmentBuilder(img.buffer, { name: img.name }));
      usedNames.add(img.name);
    }),
  );

  /* ── Build container — NO accent color = transparent glass look ─ */
  const container = new ContainerBuilder();

  /* Header */
  const headerLines = [
    `# Jellyfin — Now Playing`,
    active.length === 0
      ? `💤  *Server is idle — this panel refreshes itself.*`
      : `**${active.length} active stream${active.length === 1 ? '' : 's'}**  ·  Last updated <t:${Math.floor(Date.now() / 1000)}:R>`,
    '',
    buildStatsBlock(stats, active.length),
  ];

  if (active.length > MAX_STREAMS_PER_MESSAGE) {
    headerLines.push(`-# …and ${active.length - MAX_STREAMS_PER_MESSAGE} more hidden`);
  }

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')));

  if (visible.length > 0) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true),
    );
  }

  /* One section per stream */
  for (const [i, session] of visible.entries()) {
    const item = session.NowPlayingItem;
    const playState = session.PlayState ?? {};
    const isPaused = Boolean(playState.IsPaused);
    const isTranscode = playState.PlayMethod === 'Transcode';

    const isEpisode = item.Type === 'Episode';
    const mainTitle = isEpisode
      ? item.SeriesName ?? item.Name ?? 'Unknown'
      : item.Name ?? 'Unknown';

    const lines: string[] = [];

    /* Username */
    lines.push(`**${session.UserName ?? 'Unknown'}**`);

    /* Title */
    lines.push(`## ${mainTitle}`);

    /* Episode tag */
    if (isEpisode && item.IndexNumber != null) {
      const epTag = [
        item.ParentIndexNumber != null
          ? `S${String(item.ParentIndexNumber).padStart(2, '0')}`
          : null,
        `E${String(item.IndexNumber).padStart(2, '0')}`,
      ]
        .filter(Boolean)
        .join('');
      lines.push(`-# \`${epTag}\`  ·  *${item.Name ?? ''}*`);
    }

    /* Progress */
    const runtimeTicks: number = item.RunTimeTicks ?? 0;
    const positionTicks: number = playState.PositionTicks ?? 0;
    if (runtimeTicks > 0) {
      const cur = Math.floor(positionTicks / 10_000_000);
      const tot = Math.floor(runtimeTicks / 10_000_000);
      const pct = tot > 0 ? Math.min(100, Math.round((cur / tot) * 100)) : 0;
      lines.push(
        `${isPaused ? '⏸️' : '▶️'}  \`${createProgressBar(pct, 14)}\`  **${pct}%**  ·  \`${formatTime(cur)} / ${formatTime(tot)}\``,
      );
    } else {
      lines.push(isPaused ? '⏸️  **Paused**' : '▶️  **Playing**');
    }

    /* Delivery + client + tech */
    const techBits: string[] = [
      isTranscode ? '⚠️ Transcode' : '✅ Direct Play',
      session.Client ? session.Client : null,
    ].filter(Boolean) as string[];

    if (isTranscode && session.TranscodingInfo) {
      const t = session.TranscodingInfo;
      if (t.VideoCodec) techBits.push(String(t.VideoCodec).toUpperCase());
      if (t.AudioCodec) techBits.push(String(t.AudioCodec).toUpperCase());
      if (t.Bitrate) techBits.push(`${Math.round(t.Bitrate / 1000)} kbps`);
    }

    lines.push(`-# ${techBits.join('  ·  ')}`);

    const section = new SectionBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join('\n')),
    );

    const poster = posterRefs.get(i);
    if (poster) {
      section.setThumbnailAccessory(new ThumbnailBuilder().setURL(poster));
    }

    container.addSectionComponents(section);

    /* Separator between streams (not after the last one) */
    if (i < visible.length - 1) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true),
      );
    }
  }

  /* Footer */
  if (visible.length > 0) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true),
    );
  }
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# 🔄 Auto-refresh every 10s  ·  <t:${Math.floor(Date.now() / 1000)}:f>`,
    ),
  );

  return { components: [container], files, flags: MessageFlags.IsComponentsV2 };
}

async function startTracker(channel: TextChannel, existingMessage?: Message): Promise<void> {
  let baseUrl: string;
  try {
    baseUrl = getJellyfinBaseUrl();
  } catch {
    throw new Error('Jellyfin is not configured correctly.');
  }

  const previous = trackers.get(channel.id);
  if (previous) {
    clearInterval(previous.timer);
    trackers.delete(channel.id);
  }

  const placeholderContainer = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent('📡  *Connecting to Jellyfin…*'),
  );

  /* Pick an existing message only if it's already a V2 message. */
  let message: Message;
  if (existingMessage && existingMessage.flags.has(MessageFlags.IsComponentsV2)) {
    message = existingMessage;
  } else {
    if (existingMessage) {
      await existingMessage.delete().catch(() => {});
    }
    message = await channel.send({
      components: [placeholderContainer],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  let lastHash = '';

  const refresh = async () => {
    try {
      const payload = await buildTrackerComponents(baseUrl);

      /* ── Hash that ignores the ever-changing timestamp ─────────
         If only the "<t:...:R>" timestamp changed, the edit is skipped
         entirely — no bytes uploaded, no connection churn. */
      const rawHash = JSON.stringify({
        c: payload.components.map((c) => c.toJSON()),
        f: payload.files.map((f) => f.name),
      });
      const hash = rawHash.replace(/<t:\d+:[Rf]>/g, '<t:0:R>');

      if (hash === lastHash) return;
      lastHash = hash;

      await message.edit({
        components: payload.components,
        files: payload.files,
        flags: payload.flags,
      });
    } catch (err: any) {
      /* HTTP/2 GOAWAY / socket resets are transient — the next tick
         opens a fresh connection and succeeds. Don't spam the console. */
      const code = err?.code ?? err?.cause?.code;
      if (code === 'UND_ERR_SOCKET') return;
      console.error('[Tracker] refresh failed:', err);
    }
  };

  await refresh();

  const timer = setInterval(refresh, TRACKER_INTERVAL_MS);
  trackers.set(channel.id, { message, timer });
  persistTrackerState();
}

async function resumeTrackers(): Promise<void> {
  const states = readTrackerState();
  for (const state of states) {
    try {
      const channel = await client.channels.fetch(state.channelId);
      if (!channel || !channel.isTextBased()) continue;
      const textChannel = channel as TextChannel;
      const message = await textChannel.messages.fetch(state.messageId);
      if (!message) continue;
      await startTracker(textChannel, message);
      console.log(`[Tracker] Resumed in #${textChannel.name ?? state.channelId}`);
    } catch {
      console.warn(`[Tracker] Could not resume tracker in channel ${state.channelId}`);
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════
   BOT READY
   ══════════════════════════════════════════════════════════════════════ */

client.once(Events.ClientReady, async (readyClient) => {
  console.log('🤖 Bot is online and running natively on Proxmox LXC!');
  console.log(`Logged in as ${readyClient.user.tag}`);
  await resumeTrackers();
});

/* ══════════════════════════════════════════════════════════════════════
   INTERACTION HANDLER
   ══════════════════════════════════════════════════════════════════════ */

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() && !interaction.isStringSelectMenu() && !interaction.isButton()) return;

  if (interaction.user.id !== process.env.OWNER_ID) {
    if (interaction.isRepliable()) {
      await interaction.reply({ content: '⛔ Access denied.', ephemeral: true }).catch(() => {});
    }
    return;
  }

  /* ── /update-stack ────────────────────────────────────────────── */
  if (interaction.isChatInputCommand() && interaction.commandName === 'update-stack') {
    await interaction.deferReply();
    const vmid = interaction.options.getInteger('lxc_id', true);
    const composePath = interaction.options.getString('path') ?? '/root';

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.neutral)
          .setTitle(`🐳 Updating LXC ${vmid}`)
          .setDescription(`Pulling images and recreating containers in \`${composePath}\`…`),
      ],
    });

    try {
      const dockerCmd = `cd '${composePath.replace(/'/g, `'\\''`)}' && docker compose pull && docker compose up -d --remove-orphans && docker image prune -f`;
      const result = await executeSsh(`pct exec ${vmid} -- bash -lc "${dockerCmd}"`);

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.success)
            .setTitle('✅ Stack updated')
            .setDescription(`LXC **${vmid}** · \`${composePath}\``)
            .addFields({ name: 'Output', value: codeBlock(result, 'bash', 1000) }),
        ],
      });
    } catch (error: any) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.danger)
            .setTitle('❌ Stack update failed')
            .setDescription(`LXC **${vmid}** · \`${composePath}\``)
            .addFields({ name: 'Error', value: codeBlock(error?.message ?? 'Unknown error', 'bash', 1000) }),
        ],
      });
    }
    return;
  }

  /* ── /setup-proxmox ───────────────────────────────────────────── */
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup-proxmox') {
    await interaction.deferReply({ ephemeral: true });

    try {
      const raw = await executeSsh('pvesh get /cluster/resources --type vm --output-format json');
      const lxcs: any[] = JSON.parse(raw).filter((r: any) => r.type === 'lxc');

      if (lxcs.length === 0) {
        await interaction.editReply('No LXCs found on this Proxmox cluster.');
        return;
      }

      for (const lxc of lxcs) {
        lxcCache.set(String(lxc.vmid), { name: lxc.name, status: lxc.status, node: lxc.node });
      }

      const running = lxcs.filter((l) => l.status === 'running').length;

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('proxmox_lxc_select')
        .setPlaceholder('Select a container to manage…')
        .addOptions(
          lxcs.slice(0, 25).map((lxc) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(`${lxc.vmid} · ${lxc.name}`)
              .setDescription(`Status: ${lxc.status}${lxc.node ? ` · Node: ${lxc.node}` : ''}`)
              .setValue(String(lxc.vmid))
              .setEmoji(lxc.status === 'running' ? '🟢' : '🔴'),
          ),
        );

      const dashboard = new EmbedBuilder()
        .setColor(COLORS.neutral)
        .setAuthor({ name: 'Proxmox VE' })
        .setTitle('🖥️  Container Control Center')
        .setDescription(
          [
            'Manage your LXC containers without leaving Discord.',
            '',
            '**Available actions**',
            '> 🟢 **Start** — boot a stopped container',
            '> 🔴 **Stop** — force stop a running container',
            '> 🐳 **Update** — pull & recreate the Docker stack in `/root`',
            '',
            `-# ${lxcs.length} container(s) detected · ${running} running`,
          ].join('\n'),
        )
        .setFooter({ text: 'Select a container from the menu below' });

      const channel = interaction.channel;
      if (!channel?.isTextBased() || !('send' in channel)) {
        await interaction.editReply('This command must be used in a text channel.');
        return;
      }

      await channel.send({
        embeds: [dashboard],
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)],
      });

      await interaction.deleteReply();
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.danger)
            .setTitle('❌ Proxmox connection failed')
            .setDescription(codeBlock(message, 'bash', 1000)),
        ],
      });
    }
    return;
  }

  /* ── Proxmox dropdown ─────────────────────────────────────────── */
  if (interaction.isStringSelectMenu() && interaction.customId === 'proxmox_lxc_select') {
    const vmid = interaction.values[0];
    if (!vmid) return;
    const meta = lxcCache.get(vmid);

    const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pmx_start_${vmid}`).setLabel('Start').setEmoji('▶️').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pmx_stop_${vmid}`).setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`pmx_update_${vmid}`).setLabel('Update Docker Stack').setEmoji('🐳').setStyle(ButtonStyle.Primary),
    );

    const embed = new EmbedBuilder()
      .setColor(COLORS.neutral)
      .setAuthor({ name: 'Proxmox VE' })
      .setTitle(`⚙️  Managing LXC ${vmid}`)
      .setDescription(
        [
          `**Container:** \`${meta?.name ?? 'unknown'}\``,
          `**Status:** ${meta?.status === 'running' ? '🟢 Running' : '🔴 Stopped'}`,
          meta?.node ? `**Node:** \`${meta.node}\`` : null,
          '',
          '-# Docker updates default to the `/root` directory.',
        ]
          .filter(Boolean)
          .join('\n'),
      );

    await interaction.reply({ embeds: [embed], components: [buttonRow], ephemeral: true });
    return;
  }

  /* ── Proxmox buttons ──────────────────────────────────────────── */
  if (interaction.isButton() && interaction.customId.startsWith('pmx_')) {
    const [, action, vmid] = interaction.customId.split('_');
    if (!vmid) return;
    const meta = lxcCache.get(vmid);
    const label = meta ? `**${meta.name}** (\`${vmid}\`)` : `LXC **${vmid}**`;

    await interaction.update({
      embeds: [new EmbedBuilder().setColor(COLORS.neutral).setDescription(`⏳ Running \`${action}\` on ${label}…`)],
      components: [],
    });

    try {
      if (action === 'start') {
        await executeSsh(`pct start ${vmid}`);
        await interaction.editReply({
          embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle('✅ Container started').setDescription(`${label} is now running.`)],
        });
      } else if (action === 'stop') {
        await executeSsh(`pct stop ${vmid}`);
        await interaction.editReply({
          embeds: [new EmbedBuilder().setColor(COLORS.danger).setTitle('🛑 Container stopped').setDescription(`${label} has been shut down.`)],
        });
      } else if (action === 'update') {
        const dockerCmd = `cd /root && docker compose pull && docker compose up -d --remove-orphans && docker image prune -f`;
        const out = await executeSsh(`pct exec ${vmid} -- bash -lc "${dockerCmd}"`);
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.success)
              .setTitle('🐳 Docker stack updated')
              .setDescription(`${label} · cache pruned`)
              .addFields({ name: 'Output', value: codeBlock(out, 'bash', 1000) }),
          ],
        });
      }
    } catch (error: any) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.danger)
            .setTitle(`❌ \`${action}\` failed`)
            .setDescription(label)
            .addFields({ name: 'Error', value: codeBlock(error?.message ?? 'Unknown error', 'bash', 1000) }),
        ],
      });
    }
    return;
  }

  /* ── /setup-tracker ───────────────────────────────────────────── */
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup-tracker') {
    let baseUrl: string;
    try {
      baseUrl = getJellyfinBaseUrl();
    } catch {
      await interaction.reply({ content: 'Jellyfin is not configured correctly.', ephemeral: true });
      return;
    }

    const channel = interaction.channel;
    if (!channel?.isTextBased() || !('messages' in channel) || !('bulkDelete' in channel)) {
      await interaction.reply({ content: 'This command needs to run in a server text channel.', ephemeral: true });
      return;
    }
    const textChannel = channel as TextChannel;

    const confirmationRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('setup-tracker-clear-yes').setLabel('Yes, clear channel').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('setup-tracker-clear-no').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );

    const prompt = await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.warn)
          .setTitle('⚠️  Clear this channel?')
          .setDescription('Every message in this channel will be deleted before the dashboard is posted.'),
      ],
      components: [confirmationRow],
      ephemeral: true,
      fetchReply: true,
    });

    try {
      const confirmation = await prompt.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (b) => b.user.id === interaction.user.id,
        time: 60_000,
      });

      if (confirmation.customId !== 'setup-tracker-clear-yes') {
        await confirmation.update({
          embeds: [new EmbedBuilder().setColor(COLORS.neutral).setDescription('Cancelled.')],
          components: [],
        });
        return;
      }

      await confirmation.update({
        embeds: [new EmbedBuilder().setColor(COLORS.neutral).setDescription('🧹 Clearing channel history…')],
        components: [],
      });
    } catch {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(COLORS.neutral).setDescription('Timed out — nothing was deleted.')],
        components: [],
      });
      return;
    }

    try {
      const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const messages = await textChannel.messages.fetch({ limit: 100 });
        if (messages.size === 0) break;

        const recent = messages.filter((m) => m.createdTimestamp > twoWeeksAgo);
        const older = messages.filter((m) => m.createdTimestamp <= twoWeeksAgo);

        if (recent.size > 0) await textChannel.bulkDelete(recent, true);
        for (const m of older.values()) await m.delete().catch(() => {});
      }
    } catch (err) {
      console.error('[setup-tracker] clear failed:', err);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(COLORS.danger).setDescription('Could not fully clear the channel.')],
        components: [],
      });
    }

    /* Guide embed (regular embed) — neutral gray, no purple */
    const guideEmbed = new EmbedBuilder()
      .setColor(COLORS.neutral)
      .setAuthor({
        name: 'Jellyfin Media Server',
        ...(logoBuffer ? { iconURL: `attachment://${LOGO_ATTACHMENT_NAME}` } : {}),
      })
      .setTitle('🍿  Welcome to the homelab')
      .setDescription('Your personal media library, streamed anywhere.')
      .addFields(
        { name: '🌐  Server URL', value: `[\`${baseUrl}\`](${baseUrl})`, inline: false },
        { name: '📥  Request Media', value: '> Use **Jellyseerr** to request movies & shows.', inline: false },
        {
          name: '📱  Recommended Apps',
          value: ['**Apple** — Infuse', '**PC / Mac** — Jellyfin Media Player', '**TV** — Android TV / Roku'].join('\n'),
          inline: false,
        },
      )
      .setFooter({ text: 'Powered by Proxmox & Docker' });

    const guideFiles: AttachmentBuilder[] = [];
    const logo = logoAttachment();
    if (logo) guideFiles.push(logo);

    await textChannel.send({ embeds: [guideEmbed], files: guideFiles });

    /* Start the live tracker (V2) */
    try {
      await startTracker(textChannel);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(COLORS.success).setDescription('✅ Tracker started.')],
        components: [],
      });
    } catch (err) {
      console.error(err);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(COLORS.danger).setDescription('❌ Failed to start the tracker.')],
        components: [],
      });
    }
    return;
  }
});

console.log('[Discord] Starting bot login.');
client.login(process.env.DISCORD_TOKEN).catch(console.error);
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Message,
  type TextChannel,
} from 'discord.js';
import { Client as SshClient } from 'ssh2';
import fs from 'fs';
import os from 'os';
import path from 'path';
import 'dotenv/config';

/* ══════════════════════════════════════════════════════════════════════
   CONFIG & CONSTANTS
   ══════════════════════════════════════════════════════════════════════ */

const COLORS = {
  jellyfin: 0xaa5cc3,
  jellyfinLive: 0x10b981,
  proxmox: 0xe57000,
  success: 0x57f287,
  danger: 0xed4245,
  warn: 0xfaa61a,
  neutral: 0x2b2d31,
  paused: 0x80848e,
} as const;

const JELLYFIN_LOGO =
  'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4b/Jellyfin_logo.svg/512px-Jellyfin_logo.svg.png';

const TRACKER_INTERVAL_MS = 10_000;
const MAX_STREAMS_PER_MESSAGE = 9; // 1 header embed + 9 session embeds = 10
const MAX_FILES_PER_MESSAGE = 10;
const TRACKER_STATE_FILE = path.join(process.cwd(), '.tracker-state.json');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* ══════════════════════════════════════════════════════════════════════
   GENERIC HELPERS
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

/** Smooth gradient progress bar. */
function createProgressBar(percent: number, length = 22): string {
  const safe = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const filled = Math.round((safe / 100) * length);
  return '▰'.repeat(filled) + '▱'.repeat(Math.max(0, length - filled));
}

/** `1:02:03` / `42:17` */
function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** `1h 24m` / `18m` / `42s` */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function truncate(text: string, max: number): string {
  const clean = (text ?? '').toString().trim() || '(no output)';
  return clean.length <= max ? clean : `…\n${clean.slice(-max)}`;
}

function codeBlock(content: string, language = 'bash', max = 3800): string {
  return `\`\`\`${language}\n${truncate(content, max)}\n\`\`\``;
}

/* ══════════════════════════════════════════════════════════════════════
   PROXMOX SSH LAYER
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

/** Cache of LXC metadata so button handlers can show friendly names. */
const lxcCache = new Map<string, { name: string; status: string; node?: string }>();

function dockerUpdateCommand(dir: string): string {
  const safeDir = dir.replace(/'/g, `'\\''`);
  return `pct exec {{VMID}} -- bash -lc 'cd ${safeDir} && docker compose pull && docker compose up -d --remove-orphans && docker image prune -f'`;
}

/* ══════════════════════════════════════════════════════════════════════
   JELLYFIN TRACKER ENGINE
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

async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { headers: jellyfinHeaders() });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

interface TrackerPayload {
  embeds: EmbedBuilder[];
  files: AttachmentBuilder[];
  hash: string;
}

async function buildTrackerPayload(baseUrl: string): Promise<TrackerPayload> {
  const res = await fetch(`${baseUrl}/Sessions`, { headers: jellyfinHeaders() });
  if (!res.ok) throw new Error(`Jellyfin returned HTTP ${res.status}`);
  const sessions: any[] = await res.json();

  const active = sessions.filter((s) => s?.NowPlayingItem);

  /* ── Idle state ─────────────────────────────────────────────────── */
  if (active.length === 0) {
    const idle = new EmbedBuilder()
      .setColor(COLORS.neutral)
      .setAuthor({ name: 'Jellyfin • Live Activity', iconURL: JELLYFIN_LOGO })
      .setTitle('💤  Server is idle')
      .setDescription('No one is streaming right now.\n*This panel refreshes itself automatically.*')
      .setFooter({ text: '🔄 Auto-refresh every 10s' });

    return { embeds: [idle], files: [], hash: 'idle' };
  }

  const visible = active.slice(0, MAX_STREAMS_PER_MESSAGE);

  /* ── Pre-fetch artwork (posters get priority over avatars) ───────── */
  const files: AttachmentBuilder[] = [];
  const posterNames = new Map<number, string>();
  const avatarNames = new Map<number, string>();

  const posterJobs = visible.map(async (session, i) => {
    const item = session.NowPlayingItem;
    const imageId = item.Type === 'Episode' && item.SeriesId ? item.SeriesId : item.Id;
    if (!imageId) return;
    const buf = await fetchImage(`${baseUrl}/Items/${imageId}/Images/Primary`);
    if (!buf) return;
    posterNames.set(i, { name: `poster_${imageId}.jpg`, buf } as any);
  });
  await Promise.all(posterJobs);

  for (const [i, entry] of [...posterNames.entries()]) {
    const { name, buf } = entry as unknown as { name: string; buf: Buffer };
    if (files.length >= MAX_FILES_PER_MESSAGE) break;
    if (files.some((f) => f.name === name)) continue;
    files.push(new AttachmentBuilder(buf, { name }));
  }

  const avatarJobs = visible.map(async (session, i) => {
    if (!session.UserId) return;
    const buf = await fetchImage(`${baseUrl}/Users/${session.UserId}/Images/Primary`);
    if (!buf) return;
    avatarNames.set(i, { name: `avatar_${session.UserId}.jpg`, buf } as any);
  });
  await Promise.all(avatarJobs);

  for (const entry of avatarNames.values()) {
    const { name, buf } = entry as unknown as { name: string; buf: Buffer };
    if (files.length >= MAX_FILES_PER_MESSAGE) break;
    if (files.some((f) => f.name === name)) continue;
    files.push(new AttachmentBuilder(buf, { name }));
  }

  /* ── Build embeds ────────────────────────────────────────────────── */
  const embeds: EmbedBuilder[] = [];

  // Header
  const header = new EmbedBuilder()
    .setColor(COLORS.jellyfin)
    .setAuthor({ name: 'Jellyfin • Live Activity', iconURL: JELLYFIN_LOGO })
    .setDescription(
      [
        `### ▶️  ${active.length} active stream${active.length === 1 ? '' : 's'}`,
        active.length > MAX_STREAMS_PER_MESSAGE
          ? `-# Showing the first ${MAX_STREAMS_PER_MESSAGE} · ${active.length - MAX_STREAMS_PER_MESSAGE} more hidden`
          : '-# Everyone is behaving… for now.',
      ].join('\n'),
    )
    .setFooter({ text: '🔄 Auto-refresh every 10s' });

  embeds.push(header);

  for (const [i, session] of visible.entries()) {
    const item = session.NowPlayingItem;
    const playState = session.PlayState ?? {};
    const isPaused = Boolean(playState.IsPaused);
    const isTranscode = playState.PlayMethod === 'Transcode';

    const seriesName: string | undefined = item.SeriesName;
    const episodeTag =
      item.Type === 'Episode'
        ? [
            item.ParentIndexNumber != null ? `S${String(item.ParentIndexNumber).padStart(2, '0')}` : null,
            item.IndexNumber != null ? `E${String(item.IndexNumber).padStart(2, '0')}` : null,
          ]
            .filter(Boolean)
            .join('')
        : null;

    const embedTitle = seriesName ?? item.Name ?? 'Unknown media';

    const lines: string[] = [];

    if (seriesName) {
      lines.push(`**${episodeTag ? `${episodeTag} • ` : ''}${item.Name}**`);
    }

    lines.push(
      [
        isPaused ? '⏸️ **Paused**' : '▶️ **Playing**',
        isTranscode ? '⚠️ Transcoding' : '✅ Direct Play',
      ].join('   ·   '),
    );

    const runtimeTicks: number = item.RunTimeTicks ?? 0;
    const positionTicks: number = playState.PositionTicks ?? 0;

    if (runtimeTicks > 0) {
      const cur = Math.floor(positionTicks / 10_000_000);
      const tot = Math.floor(runtimeTicks / 10_000_000);
      const pct = tot > 0 ? Math.min(100, Math.round((cur / tot) * 100)) : 0;
      const left = Math.max(0, tot - cur);

      lines.push('');
      lines.push(`\`${createProgressBar(pct)}\``);
      lines.push(`⏱️ \`${formatTime(cur)} / ${formatTime(tot)}\`   ·   ⏳ **${formatDuration(left)}** left   ·   \`${pct}%\``);
    }

    // Transcoding details (compact)
    const t = session.TranscodingInfo;
    if (isTranscode && t) {
      const bits: string[] = [];
      if (t.VideoCodec) bits.push(`🎞️ ${String(t.VideoCodec).toUpperCase()}`);
      if (t.AudioCodec) bits.push(`🔊 ${String(t.AudioCodec).toUpperCase()}`);
      if (t.Bitrate) bits.push(`📶 ${Math.round(t.Bitrate / 1000)} kbps`);
      if (bits.length) lines.push(bits.join('   ·   '));
    }

    const embed = new EmbedBuilder()
      .setColor(isPaused ? COLORS.paused : isTranscode ? COLORS.warn : COLORS.jellyfinLive)
      .setTitle(truncate(embedTitle, 250))
      .setDescription(truncate(lines.join('\n'), 4000));

    // Author = user + client (+ avatar)
    const authorName = `${session.UserName ?? 'Unknown'}  ·  ${session.Client ?? 'Unknown client'}`;
    const avatarEntry = avatarNames.get(i) as unknown as { name: string } | undefined;
    embed.setAuthor(avatarEntry ? { name: authorName, iconURL: `attachment://${avatarEntry.name}` } : { name: authorName });

    // Thumbnail = poster
    const posterEntry = posterNames.get(i) as unknown as { name: string } | undefined;
    if (posterEntry) embed.setThumbnail(`attachment://${posterEntry.name}`);

    embeds.push(embed);
  }

  const hash = JSON.stringify({
    e: embeds.map((e) => e.toJSON()),
    f: files.map((f) => f.name),
  });

  return { embeds, files, hash };
}

async function startTracker(channel: TextChannel, existingMessage?: Message): Promise<void> {
  let baseUrl: string;
  try {
    baseUrl = getJellyfinBaseUrl();
  } catch {
    throw new Error('Jellyfin is not configured correctly.');
  }

  // Tear down any previous tracker on this channel
  const previous = trackers.get(channel.id);
  if (previous) {
    clearInterval(previous.timer);
    trackers.delete(channel.id);
  }

  const placeholder = new EmbedBuilder()
    .setColor(COLORS.neutral)
    .setDescription('📡 *Connecting to Jellyfin…*');

  const message = existingMessage ?? (await channel.send({ embeds: [placeholder] }));

  let lastHash = '';

  const refresh = async () => {
    try {
      const payload = await buildTrackerPayload(baseUrl);
      if (payload.hash === lastHash) return; // nothing changed → skip the edit
      lastHash = payload.hash;
      await message.edit({ embeds: payload.embeds, files: payload.files });
    } catch (err) {
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
  console.log('🤖 Bot is online and running natively on macOS!');
  console.log(`Logged in as ${readyClient.user.tag}`);
  await resumeTrackers();
});

/* ══════════════════════════════════════════════════════════════════════
   INTERACTION HANDLER
   ══════════════════════════════════════════════════════════════════════ */

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() && !interaction.isStringSelectMenu() && !interaction.isButton()) return;

  /* 🔒 Gatekeeper */
  if (interaction.user.id !== process.env.OWNER_ID) {
    if (interaction.isRepliable()) {
      await interaction.reply({ content: '⛔ Access denied.', ephemeral: true }).catch(() => {});
    }
    return;
  }

  /* ════════════════════════════════════════════════════════════════
     /update-stack
     ════════════════════════════════════════════════════════════════ */
  if (interaction.isChatInputCommand() && interaction.commandName === 'update-stack') {
    await interaction.deferReply();
    const vmid = interaction.options.getInteger('lxc_id', true);
    const composePath = interaction.options.getString('path') ?? '/root';

    const embed = new EmbedBuilder()
      .setAuthor({ name: 'Proxmox • Docker Stack', iconURL: undefined })
      .setColor(COLORS.proxmox)
      .setTitle(`🐳 Updating LXC ${vmid}`)
      .setDescription(`Pulling images and recreating containers in \`${composePath}\`…`);

    await interaction.editReply({ embeds: [embed] });

    try {
      const dockerCmd = `cd '${composePath.replace(/'/g, `'\\''`)}' && docker compose pull && docker compose up -d --remove-orphans && docker image prune -f`;
      const result = await executeSsh(`pct exec ${vmid} -- bash -lc "${dockerCmd}"`);

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.success)
            .setTitle('✅ Stack updated')
            .setDescription(`LXC **${vmid}** · \`${composePath}\``)
            .addFields({ name: 'Output', value: codeBlock(result, 'bash', 1000) })
            .setFooter({ text: 'docker compose pull && up -d && image prune' }),
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

  /* ════════════════════════════════════════════════════════════════
     /setup-proxmox
     ════════════════════════════════════════════════════════════════ */
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup-proxmox') {
    await interaction.deferReply({ ephemeral: true });

    try {
      const raw = await executeSsh('pvesh get /cluster/resources --type vm --output-format json');
      const lxcs: any[] = JSON.parse(raw).filter((r: any) => r.type === 'lxc');

      if (lxcs.length === 0) {
        await interaction.editReply('No LXCs found on this Proxmox cluster.');
        return;
      }

      // Cache metadata for later button presses
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
        .setColor(COLORS.proxmox)
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

  /* ════════════════════════════════════════════════════════════════
     Proxmox dropdown selection
     ════════════════════════════════════════════════════════════════ */
  if (interaction.isStringSelectMenu() && interaction.customId === 'proxmox_lxc_select') {
    const vmid = interaction.values[0];
    const meta = lxcCache.get(vmid);
    const label = meta ? `${meta.name}` : 'unknown';

    const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pmx_start_${vmid}`).setLabel('Start').setEmoji('▶️').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pmx_stop_${vmid}`).setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`pmx_update_${vmid}`)
        .setLabel('Update Docker Stack')
        .setEmoji('🐳')
        .setStyle(ButtonStyle.Primary),
    );

    const embed = new EmbedBuilder()
      .setColor(COLORS.proxmox)
      .setAuthor({ name: 'Proxmox VE' })
      .setTitle(`⚙️  Managing LXC ${vmid}`)
      .setDescription(
        [
          `**Container:** \`${label}\``,
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

  /* ════════════════════════════════════════════════════════════════
     Proxmox control buttons
     ════════════════════════════════════════════════════════════════ */
  if (interaction.isButton() && interaction.customId.startsWith('pmx_')) {
    const [, action, vmid] = interaction.customId.split('_');
    const meta = lxcCache.get(vmid);
    const label = meta ? `**${meta.name}** (\`${vmid}\`)` : `LXC **${vmid}**`;

    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.neutral)
          .setDescription(`⏳ Running \`${action}\` on ${label}…`),
      ],
      components: [],
    });

    try {
      if (action === 'start') {
        await executeSsh(`pct start ${vmid}`);
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.success)
              .setTitle('✅ Container started')
              .setDescription(`${label} is now running.`),
          ],
        });
      } else if (action === 'stop') {
        await executeSsh(`pct stop ${vmid}`);
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.danger)
              .setTitle('🛑 Container stopped')
              .setDescription(`${label} has been shut down.`),
          ],
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

  /* ════════════════════════════════════════════════════════════════
     /setup-tracker
     ════════════════════════════════════════════════════════════════ */
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

    /* ── Confirmation ───────────────────────────────────────────── */
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

    /* ── Post the guide ─────────────────────────────────────────── */
    const guideEmbed = new EmbedBuilder()
      .setColor(COLORS.jellyfin)
      .setAuthor({ name: 'Jellyfin Media Server', iconURL: JELLYFIN_LOGO })
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

    await textChannel.send({ embeds: [guideEmbed] });

    /* ── Start the live tracker ─────────────────────────────────── */
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
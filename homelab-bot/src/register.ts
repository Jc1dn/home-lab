import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import 'dotenv/config';

const commands = [
  new SlashCommandBuilder()
    .setName('update-stack')
    .setDescription('Update a Docker compose stack inside a Proxmox LXC')
    .addIntegerOption(option => 
      option.setName('lxc_id')
        .setDescription('The Proxmox VMID (e.g., 104)')
        .setRequired(true)
    )
    .addStringOption(option => 
      option.setName('path')
        .setDescription('Path to the docker-compose.yml (Defaults to /root)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('setup-tracker')
    .setDescription('Spawns the Jellyfin guides and live tracker dashboard in this channel'),

  // --- NEW COMMAND ---
  new SlashCommandBuilder()
    .setName('setup-proxmox')
    .setDescription('Spawns the Proxmox management dashboard with a server selection menu')
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN as string);

async function registerCommands() {
  try {
    console.log('Started refreshing application (/) commands...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID as string), { body: commands });
    console.log('✅ Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
}
registerCommands();
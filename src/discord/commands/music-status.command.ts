import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';

import type { GuildSettingsRepository } from '../../database/repositories/guild-settings.repository.js';

export const musicStatusCommand = new SlashCommandBuilder()
  .setName('music-status')
  .setDescription('Show music configuration and current player state');

export async function executeMusicStatusCommand(
  interaction: ChatInputCommandInteraction,
  settingsRepository: GuildSettingsRepository
): Promise<void> {
  if (!interaction.guild) {
    await interaction.editReply({ content: 'This command can only run in a server.' });
    return;
  }

  const settings = await settingsRepository.getOrCreate(interaction.guild.id);
  await interaction.editReply({
    content: [
      `Player channel: ${settings.playerChannelId ? `<#${settings.playerChannelId}>` : 'not configured'}`,
      `Player message: ${settings.playerMessageId ?? 'not configured'}`,
      'Cleanup: always enabled in the player channel',
      `DJ role: ${settings.djRoleId ? `<@&${settings.djRoleId}>` : 'not configured'}`
    ].join('\n')
  });
}

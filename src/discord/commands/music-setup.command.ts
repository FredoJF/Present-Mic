import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction
} from 'discord.js';

import type { GuildSettingsRepository } from '../../database/repositories/guild-settings.repository.js';
import type { GuildTextBasedChannel } from 'discord.js';
import type { PlayerMessageService } from '../../player-channel/player-message-service.js';

export const musicSetupCommand = new SlashCommandBuilder()
  .setName('music')
  .setDescription('Music setup and admin actions')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Set the channel used as the player interface')
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Text channel where the persistent player lives')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText)
      )
  )
  .addSubcommand((sub) => sub.setName('reset-player').setDescription('Recreate the player message'))
  .addSubcommand((sub) =>
    sub
      .setName('set-dj-role')
      .setDescription('Set optional DJ role')
      .addRoleOption((option) => option.setName('role').setDescription('Role allowed to control player').setRequired(true))
  )
  .addSubcommand((sub) => sub.setName('unset-dj-role').setDescription('Disable DJ role restriction'))
  .addSubcommand((sub) =>
    sub
      .setName('cleanup')
      .setDescription('Toggle deletion of processed messages in player channel')
      .addBooleanOption((option) => option.setName('enabled').setDescription('Enable automatic cleanup').setRequired(true))
  )
  .addSubcommand((sub) => sub.setName('status').setDescription('Show current guild music configuration'));

export async function executeMusicSetupCommand(
  interaction: ChatInputCommandInteraction,
  settingsRepository: GuildSettingsRepository,
  playerMessageService: PlayerMessageService
): Promise<void> {
  if (!interaction.guild) {
    await interaction.editReply({ content: 'This command can only run in a server.' });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'setup') {
    const channel = interaction.options.getChannel('channel', true);
    if (channel.type !== ChannelType.GuildText) {
      await interaction.editReply({ content: 'Choose a text channel.' });
      return;
    }

    const currentSettings = await settingsRepository.getOrCreate(interaction.guild.id);
    if (currentSettings.playerChannelId && currentSettings.playerChannelId !== channel.id) {
      const previousChannel = await interaction.guild.channels.fetch(currentSettings.playerChannelId).catch(() => null);
      if (previousChannel?.isTextBased() && !previousChannel.isDMBased()) {
        await playerMessageService.cleanupChannel(previousChannel as GuildTextBasedChannel);
      }
    }

    const playerMessage = await playerMessageService.ensureMessage(
      channel as GuildTextBasedChannel,
      currentSettings.playerChannelId === channel.id ? currentSettings.playerMessageId : null
    );
    await settingsRepository.upsert(interaction.guild.id, {
      playerChannelId: channel.id,
      playerMessageId: playerMessage.id,
      cleanupEnabled: true
    });

    await interaction.editReply({
      content: `Player channel configured: <#${channel.id}>. Processed messages will be cleaned so the player stays as the only visible bot message.`
    });
    return;
  }

  if (sub === 'reset-player') {
    const settings = await settingsRepository.get(interaction.guild.id);
    if (!settings?.playerChannelId) {
      await interaction.editReply({
        content: 'Set up a player channel first with /music setup.'
      });
      return;
    }

    const channel = await interaction.guild.channels.fetch(settings.playerChannelId);
    if (!channel || !channel.isTextBased()) {
      await interaction.editReply({ content: 'Configured player channel is missing.' });
      return;
    }

    const playerMessage = await playerMessageService.ensureMessage(
      channel as GuildTextBasedChannel,
      settings.playerMessageId
    );
    await settingsRepository.upsert(interaction.guild.id, {
      playerMessageId: playerMessage.id
    });

    await interaction.editReply({ content: 'Player message reset complete.' });
    return;
  }

  if (sub === 'set-dj-role') {
    const role = interaction.options.getRole('role', true);
    await settingsRepository.upsert(interaction.guild.id, { djRoleId: role.id });
    await interaction.editReply({ content: `DJ role set to ${role.name}.` });
    return;
  }

  if (sub === 'unset-dj-role') {
    await settingsRepository.upsert(interaction.guild.id, { djRoleId: null });
    await interaction.editReply({ content: 'DJ role restriction disabled.' });
    return;
  }

  if (sub === 'cleanup') {
    const enabled = interaction.options.getBoolean('enabled', true);
    await settingsRepository.upsert(interaction.guild.id, { cleanupEnabled: true });
    await interaction.editReply({
      content: enabled
        ? 'Player-channel user message cleanup is always enabled.'
        : 'Player-channel user message cleanup cannot be disabled while single-player mode is enforced.'
    });
    return;
  }

  const status = await settingsRepository.getOrCreate(interaction.guild.id);
  await interaction.editReply({
    content: [
      'Music configuration:',
      `Player channel: ${status.playerChannelId ? `<#${status.playerChannelId}>` : 'not set'}`,
      `Player message: ${status.playerMessageId ?? 'not set'}`,
      `DJ role: ${status.djRoleId ? `<@&${status.djRoleId}>` : 'not set'}`,
      'Cleanup: always enabled in the player channel'
    ].join('\n')
  });
}

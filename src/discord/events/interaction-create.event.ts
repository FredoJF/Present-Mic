import { MessageFlags, type Client } from 'discord.js';

import type { GuildSettingsRepository } from '../../database/repositories/guild-settings.repository.js';
import { executeMusicSetupCommand } from '../commands/music-setup.command.js';
import { executeMusicStatusCommand } from '../commands/music-status.command.js';
import { PLAYER_BUTTON_IDS } from '../components/player-buttons.js';
import type { MusicService } from '../../music/music-service.js';
import type { PlayerMessageService } from '../../player-channel/player-message-service.js';
import { canControlPlayer } from '../../permissions/music-permissions.js';
import { buildQueueText } from '../../player-channel/queue-message-builder.js';
import { logger } from '../../utils/logger.js';

function isPrismaMissingTableError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2021';
}

function nextLoopMode(current: 'off' | 'track' | 'queue'): 'off' | 'track' | 'queue' {
  if (current === 'off') {
    return 'track';
  }
  if (current === 'track') {
    return 'queue';
  }
  return 'off';
}

export function bindInteractionCreateEvent(
  client: Client,
  settingsRepository: GuildSettingsRepository,
  musicService: MusicService,
  playerMessageService: PlayerMessageService
): void {
  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (interaction.commandName === 'music') {
          await executeMusicSetupCommand(interaction, settingsRepository, playerMessageService);
        }

        if (interaction.commandName === 'music-status') {
          await executeMusicStatusCommand(interaction, settingsRepository);
        }

        return;
      }

      if (!interaction.isButton() || !interaction.inCachedGuild()) {
        return;
      }

      const queueRequested = interaction.customId === PLAYER_BUTTON_IDS.queue;
      if (queueRequested) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      } else {
        await interaction.deferUpdate();
      }

      const settings = await settingsRepository.getOrCreate(interaction.guild.id);
      if (!canControlPlayer({ member: interaction.member, djRoleId: settings.djRoleId })) {
        if (queueRequested) {
          await interaction.editReply({ content: 'You are not allowed to control the player.' });
        } else {
          await interaction.followUp({
            content: 'You are not allowed to control the player.',
            flags: MessageFlags.Ephemeral
          });
        }
        return;
      }

      const state = musicService.getState(interaction.guild.id);

      if (interaction.customId === PLAYER_BUTTON_IDS.pauseResume) {
        if (state.isPaused) {
          await musicService.resume(interaction.guild.id);
        } else {
          await musicService.pause(interaction.guild.id);
        }
      }

      if (interaction.customId === PLAYER_BUTTON_IDS.next) {
        await musicService.playNext(interaction.guild.id);
      }

      if (interaction.customId === PLAYER_BUTTON_IDS.previous) {
        await musicService.playPrevious(interaction.guild.id);
      }

      if (interaction.customId === PLAYER_BUTTON_IDS.stop) {
        await musicService.stop(interaction.guild.id);
      }

      if (interaction.customId === PLAYER_BUTTON_IDS.shuffle) {
        musicService.shuffle(interaction.guild.id);
      }

      if (interaction.customId === PLAYER_BUTTON_IDS.clear) {
        musicService.clearQueue(interaction.guild.id);
      }

      if (interaction.customId === PLAYER_BUTTON_IDS.loop) {
        const nextMode = nextLoopMode(state.loopMode);
        musicService.setLoopMode(interaction.guild.id, nextMode);
      }

      if (queueRequested) {
        await interaction.editReply({ content: buildQueueText(state) });
        return;
      }

      if (settings.playerChannelId && settings.playerMessageId) {
        const channel = await interaction.guild.channels.fetch(settings.playerChannelId);
        if (channel?.isTextBased()) {
          const newMessageId = await playerMessageService.updateOrRecreate(
            channel,
            settings.playerMessageId,
            musicService.getState(interaction.guild.id)
          );

          if (newMessageId !== settings.playerMessageId) {
            await settingsRepository.upsert(interaction.guild.id, {
              playerMessageId: newMessageId
            });
          }
        }
      }

    } catch (error) {
      logger.error({ error }, 'Interaction handling failed');
      if (interaction.isRepliable()) {
        const content = isPrismaMissingTableError(error)
          ? 'Database is not initialized on this deployment. Run `npm run prisma:migrate:deploy` and restart the bot.'
          : 'An error happened while handling this interaction.';

        const payload = {
          content,
          flags: MessageFlags.Ephemeral as const
        };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(payload).catch(() => undefined);
        } else {
          await interaction.reply(payload).catch(() => undefined);
        }
      }
    }
  });
}

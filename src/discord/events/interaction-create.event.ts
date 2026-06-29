import {
  DiscordAPIError,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client
} from 'discord.js';

import { isPrismaMissingTableError } from '../../database/prisma-errors.js';
import type { GuildSettingsRepository } from '../../database/repositories/guild-settings.repository.js';
import { executeMusicSetupCommand } from '../commands/music-setup.command.js';
import { executeMusicStatusCommand } from '../commands/music-status.command.js';
import { PLAYER_BUTTON_IDS } from '../components/player-buttons.js';
import type { MusicService } from '../../music/music-service.js';
import type { PlayerMessageService } from '../../player-channel/player-message-service.js';
import { canControlPlayer } from '../../permissions/music-permissions.js';
import { buildQueueText } from '../../player-channel/queue-message-builder.js';
import { logger } from '../../utils/logger.js';

function nextLoopMode(current: 'off' | 'track' | 'queue'): 'off' | 'track' | 'queue' {
  if (current === 'off') {
    return 'track';
  }
  if (current === 'track') {
    return 'queue';
  }
  return 'off';
}

function isUnknownInteractionError(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === 10062;
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
        await handleChatInputCommand(interaction, settingsRepository, playerMessageService);
        return;
      }

      if (!interaction.isButton() || !interaction.inCachedGuild()) {
        return;
      }

      await handlePlayerButtonInteraction(
        interaction,
        settingsRepository,
        musicService,
        playerMessageService
      );
    } catch (error) {
      if (isUnknownInteractionError(error)) {
        logger.warn(
          {
            customId: interaction.isButton() ? interaction.customId : null,
            guildId: interaction.guildId ?? null,
            interactionId: interaction.id,
            interactionType: interaction.type
          },
          'Ignoring expired or already-acknowledged Discord interaction'
        );
        return;
      }

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

async function handleChatInputCommand(
  interaction: ChatInputCommandInteraction,
  settingsRepository: GuildSettingsRepository,
  playerMessageService: PlayerMessageService
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (interaction.commandName === 'music') {
    await executeMusicSetupCommand(interaction, settingsRepository, playerMessageService);
    return;
  }

  if (interaction.commandName === 'music-status') {
    await executeMusicStatusCommand(interaction, settingsRepository);
  }
}

async function handlePlayerButtonInteraction(
  interaction: ButtonInteraction<'cached'>,
  settingsRepository: GuildSettingsRepository,
  musicService: MusicService,
  playerMessageService: PlayerMessageService
): Promise<void> {
  const queueRequested = interaction.customId === PLAYER_BUTTON_IDS.queue;

  if (queueRequested) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } else {
    await interaction.deferUpdate();
  }

  const settings = await settingsRepository.getOrCreate(interaction.guild.id);
  if (!canControlPlayer({ member: interaction.member, djRoleId: settings.djRoleId })) {
    await replyDeniedControl(interaction, queueRequested);
    return;
  }

  const state = musicService.getState(interaction.guild.id);

  // Playback state mutations are grouped here so the button flow stays easy to scan.
  switch (interaction.customId) {
    case PLAYER_BUTTON_IDS.pauseResume:
      if (state.isPaused) {
        await musicService.resume(interaction.guild.id);
      } else {
        await musicService.pause(interaction.guild.id);
      }
      break;
    case PLAYER_BUTTON_IDS.next:
      await musicService.playNext(interaction.guild.id);
      break;
    case PLAYER_BUTTON_IDS.previous:
      await musicService.playPrevious(interaction.guild.id);
      break;
    case PLAYER_BUTTON_IDS.stop:
      await musicService.stop(interaction.guild.id);
      break;
    case PLAYER_BUTTON_IDS.shuffle:
      musicService.shuffle(interaction.guild.id);
      break;
    case PLAYER_BUTTON_IDS.clear:
      musicService.clearQueue(interaction.guild.id);
      break;
    case PLAYER_BUTTON_IDS.loop:
      musicService.setLoopMode(interaction.guild.id, nextLoopMode(state.loopMode));
      break;
    case PLAYER_BUTTON_IDS.queue:
      await interaction.editReply({ content: buildQueueText(state) });
      return;
    default:
      return;
  }

  await syncPersistentPlayerMessage(
    interaction,
    settingsRepository,
    musicService,
    playerMessageService,
    settings
  );
}

async function replyDeniedControl(
  interaction: ButtonInteraction<'cached'>,
  queueRequested: boolean
): Promise<void> {
  if (queueRequested) {
    await interaction.editReply({ content: 'You are not allowed to control the player.' });
    return;
  }

  await interaction.followUp({
    content: 'You are not allowed to control the player.',
    flags: MessageFlags.Ephemeral
  });
}

async function syncPersistentPlayerMessage(
  interaction: ButtonInteraction<'cached'>,
  settingsRepository: GuildSettingsRepository,
  musicService: MusicService,
  playerMessageService: PlayerMessageService,
  settings: Awaited<ReturnType<GuildSettingsRepository['getOrCreate']>>
): Promise<void> {
  if (!settings.playerChannelId || !settings.playerMessageId) {
    return;
  }

  const channel = await interaction.guild.channels.fetch(settings.playerChannelId);
  if (!channel?.isTextBased()) {
    return;
  }

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

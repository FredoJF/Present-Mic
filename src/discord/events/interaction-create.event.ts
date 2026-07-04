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
  await interaction.deferUpdate();

  const settings = await settingsRepository.getOrCreate(interaction.guild.id);
  if (!canControlPlayer({ member: interaction.member, djRoleId: settings.djRoleId })) {
    await replyDeniedControl(interaction);
    return;
  }

  const state = musicService.getState(interaction.guild.id);

  const action = startPlayerButtonAction(
    interaction.customId,
    interaction.guild.id,
    state,
    musicService
  );
  if (!action) {
    return;
  }

  await syncPersistentPlayerMessage(interaction, musicService, playerMessageService);
  await action;
}

function startPlayerButtonAction(
  customId: string,
  guildId: string,
  state: ReturnType<MusicService['getState']>,
  musicService: MusicService
): Promise<void> | null {
  switch (customId) {
    case PLAYER_BUTTON_IDS.pauseResume:
      return togglePauseResume(guildId, state.isPaused, musicService);
    case PLAYER_BUTTON_IDS.next:
      return toVoidPromise(musicService.playNext(guildId));
    case PLAYER_BUTTON_IDS.previous:
      return toVoidPromise(musicService.playPrevious(guildId));
    case PLAYER_BUTTON_IDS.stop:
      return musicService.stop(guildId);
    case PLAYER_BUTTON_IDS.shuffle:
      musicService.shuffle(guildId);
      return Promise.resolve();
    case PLAYER_BUTTON_IDS.clear:
      musicService.clearQueue(guildId);
      return Promise.resolve();
    case PLAYER_BUTTON_IDS.loop:
      musicService.setLoopMode(guildId, nextLoopMode(state.loopMode));
      return Promise.resolve();
    default:
      return null;
  }
}

async function togglePauseResume(
  guildId: string,
  isPaused: boolean,
  musicService: MusicService
): Promise<void> {
  if (isPaused) {
    await musicService.resume(guildId);
    return;
  }

  await musicService.pause(guildId);
}

async function syncPersistentPlayerMessage(
  interaction: ButtonInteraction<'cached'>,
  musicService: MusicService,
  playerMessageService: PlayerMessageService
): Promise<void> {
  await playerMessageService.updateMessageImmediate(
    interaction.message,
    musicService.getState(interaction.guild.id)
  );
}

function toVoidPromise<T>(promise: Promise<T>): Promise<void> {
  return promise.then(() => undefined);
}

async function replyDeniedControl(interaction: ButtonInteraction<'cached'>): Promise<void> {
  await interaction.followUp({
    content: 'You are not allowed to control the player.',
    flags: MessageFlags.Ephemeral
  });
}

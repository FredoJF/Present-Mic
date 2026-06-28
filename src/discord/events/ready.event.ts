import type { Client } from 'discord.js';

import type { GuildSettingsRepository } from '../../database/repositories/guild-settings.repository.js';
import type { MusicService } from '../../music/music-service.js';
import type { PlayerMessageService } from '../../player-channel/player-message-service.js';
import { logger } from '../../utils/logger.js';

export function bindReadyEvent(
  client: Client,
  settingsRepository: GuildSettingsRepository,
  musicService: MusicService,
  playerMessageService: PlayerMessageService
): void {
  client.once('clientReady', () => {
    logger.info({ user: client.user?.tag }, 'Discord client is ready');

    void synchronizePlayerChannels(client, settingsRepository, musicService, playerMessageService).catch((error) => {
      logger.error({ error }, 'Failed to reconcile persistent player messages on startup');
    });
  });
}

async function synchronizePlayerChannels(
  client: Client,
  settingsRepository: GuildSettingsRepository,
  musicService: MusicService,
  playerMessageService: PlayerMessageService
): Promise<void> {
  const settingsList = await settingsRepository.listWithPlayerChannel();

  for (const settings of settingsList) {
    const guild = client.guilds.cache.get(settings.guildId) ?? (await client.guilds.fetch(settings.guildId).catch(() => null));
    if (!guild || !settings.playerChannelId) {
      continue;
    }

    const channel = await guild.channels.fetch(settings.playerChannelId).catch(() => null);
    if (!channel?.isTextBased() || channel.isDMBased()) {
      continue;
    }

    const ensuredMessage = await playerMessageService.ensureMessage(
      channel,
      settings.playerMessageId,
      musicService.getState(settings.guildId)
    );

    if (ensuredMessage.id !== settings.playerMessageId) {
      await settingsRepository.upsert(settings.guildId, {
        playerMessageId: ensuredMessage.id
      });
    }
  }
}

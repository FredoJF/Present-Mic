import type { Client, GuildTextBasedChannel } from 'discord.js';

import type { GuildSettingsRepository } from '../database/repositories/guild-settings.repository.js';
import { logger } from '../utils/logger.js';
import type { PlayerMessageService } from './player-message-service.js';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Periodically clears the player channel so only the player message remains.
 *
 * Most clutter is already handled at the point it is created: input messages are
 * deleted once processed, and feedback is posted as a self-deleting notice. This
 * sweep is the backstop for what those paths cannot catch — notices whose delete
 * timer was lost to a restart, messages posted while the bot was offline, and
 * anything a failed delete left behind.
 */
export class PlayerChannelCleaner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  public constructor(
    private readonly client: Client,
    private readonly settingsRepository: GuildSettingsRepository,
    private readonly playerMessageService: PlayerMessageService
  ) {}

  public start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.sweepAllGuilds();
    }, SWEEP_INTERVAL_MS);

    // A cosmetic sweep must never keep the process alive on shutdown.
    this.timer.unref();

    logger.info({ intervalMs: SWEEP_INTERVAL_MS }, 'Player channel cleaner started');
  }

  public stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  public async sweepAllGuilds(): Promise<void> {
    // Sweeps are not worth overlapping; a slow one just yields to the next tick.
    if (this.sweeping) {
      return;
    }

    this.sweeping = true;
    try {
      const settingsList = await this.settingsRepository.listWithPlayerChannel();

      for (const settings of settingsList) {
        if (!settings.playerChannelId) {
          continue;
        }

        try {
          await this.sweepGuild(
            settings.guildId,
            settings.playerChannelId,
            settings.playerMessageId
          );
        } catch (error) {
          logger.warn(
            { error, guildId: settings.guildId, channelId: settings.playerChannelId },
            'Failed to sweep player channel'
          );
        }
      }
    } catch (error) {
      logger.warn({ error }, 'Player channel sweep aborted');
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepGuild(
    guildId: string,
    playerChannelId: string,
    playerMessageId: string | null
  ): Promise<void> {
    const guild =
      this.client.guilds.cache.get(guildId) ??
      (await this.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
      return;
    }

    const channel = await guild.channels.fetch(playerChannelId).catch(() => null);
    if (!channel?.isTextBased() || channel.isDMBased()) {
      return;
    }

    const deleted = await this.playerMessageService.cleanupChannel(
      channel as GuildTextBasedChannel,
      playerMessageId
    );

    if (deleted > 0) {
      logger.info({ guildId, channelId: playerChannelId, deleted }, 'Swept player channel');
    }
  }
}

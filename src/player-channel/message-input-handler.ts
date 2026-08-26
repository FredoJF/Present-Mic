import type { Message } from 'discord.js';

import type { GuildSettingsRepository } from '../database/repositories/guild-settings.repository.js';
import type { MusicService } from '../music/music-service.js';
import { logger } from '../utils/logger.js';
import { sendTransientNotice } from './transient-notice.js';

export class MessageInputHandler {
  public constructor(
    private readonly settingsRepository: GuildSettingsRepository,
    private readonly musicService: MusicService
  ) {}

  public async handle(message: Message): Promise<void> {
    if (!message.guild || message.author.bot) {
      return;
    }

    const settings = await this.settingsRepository.get(message.guild.id);
    if (!settings?.playerChannelId || message.channel.id !== settings.playerChannelId) {
      return;
    }

    try {
      if (!message.member?.voice.channelId) {
        await message.delete().catch(() => undefined);
        return;
      }

      const input = message.content.trim();
      if (!input) {
        return;
      }

      await this.musicService.addFromInput({
        guildId: message.guild.id,
        textChannelId: message.channel.id,
        voiceChannelId: message.member.voice.channelId,
        query: input,
        requestedByUserId: message.author.id,
        requestedByDisplayName: message.member.displayName
      });

      // Player message updates are handled centrally via MusicService state listeners.
    } catch (error) {
      const details = error instanceof Error ? error.message : 'Unknown error';
      logger.warn(
        { error, guildId: message.guild.id, query: message.content },
        'Failed to resolve music input'
      );
      // Posted as a self-deleting notice rather than a reply: a reply would
      // survive the deletion of the message it points at and linger in the
      // channel until removed by hand.
      if (message.channel.isSendable()) {
        await sendTransientNotice(message.channel, `I couldn't queue that input: ${details}`);
      }
    } finally {
      await message.delete().catch(() => undefined);
    }
  }
}

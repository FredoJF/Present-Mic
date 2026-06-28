import type { Message } from 'discord.js';

import type { GuildSettingsRepository } from '../database/repositories/guild-settings.repository.js';
import type { MusicService } from '../music/music-service.js';

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
    } finally {
      await message.delete().catch(() => undefined);
    }
  }
}

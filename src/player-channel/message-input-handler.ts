import type { Message } from 'discord.js';

import type { GuildSettingsRepository } from '../database/repositories/guild-settings.repository.js';
import type { MusicService } from '../music/music-service.js';
import { logger } from '../utils/logger.js';
import { sendTransientNotice, startDeferredNotice } from './transient-notice.js';

/** URL path segments that mean the input expands into many tracks. */
const MULTI_TRACK_SEGMENTS = new Set(['playlist', 'album', 'artist', 'sets']);

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

    if (!message.member?.voice.channelId) {
      await message.delete().catch(() => undefined);
      return;
    }

    const input = message.content.trim();
    if (!input) {
      await message.delete().catch(() => undefined);
      return;
    }

    const channel = message.channel;
    // Resolving a large playlist can take ten seconds or more, because LavaSrc
    // pages it and may need a fresh anonymous token first. Without feedback that
    // reads as the bot ignoring the request. The notice only appears if the work
    // is genuinely slow, so a plain YouTube link still posts nothing.
    const progress = channel.isSendable()
      ? startDeferredNotice(channel, this.describePendingWork(input))
      : null;

    let failureReason: string | null = null;

    try {
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
      logger.warn(
        { error, guildId: message.guild.id, query: input },
        'Failed to resolve music input'
      );
      failureReason = error instanceof Error ? error.message : 'Unknown error';
    }

    // Clear the progress notice before reporting an outcome, so the two are
    // never visible at the same time.
    await progress?.dismiss();

    if (failureReason && channel.isSendable()) {
      // A self-deleting notice rather than a reply: a reply would survive the
      // deletion of the message it points at and linger in the channel.
      await sendTransientNotice(channel, `I couldn't queue that input: ${failureReason}`);
    }

    await message.delete().catch(() => undefined);
  }

  /** Names the pending work so the notice is specific about what is slow. */
  private describePendingWork(input: string): string {
    if (!input.toLowerCase().startsWith('http')) {
      return `🔎 Searching for **${this.truncate(input)}**…`;
    }

    try {
      const url = new URL(input);
      const segments = url.pathname.split('/').filter(Boolean);

      if (segments.some((segment) => MULTI_TRACK_SEGMENTS.has(segment.toLowerCase()))) {
        return '💿 Loading playlist… this can take a moment for large ones.';
      }

      // YouTube marks playlists with a query parameter rather than a path.
      if (url.searchParams.has('list')) {
        return '💿 Loading playlist… this can take a moment for large ones.';
      }
    } catch {
      // Not a parseable URL; fall through to the generic notice.
    }

    return '⏳ Loading track…';
  }

  private truncate(value: string): string {
    const maxLength = 80;
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
  }
}

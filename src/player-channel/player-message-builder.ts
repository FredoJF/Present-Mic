import { EmbedBuilder } from 'discord.js';

import type { GuildPlayerState } from '../music/player-state.js';

const EMBED_COLOR = 0x23899d;
const QUEUE_PREVIEW_LIMIT = 30;
const MAX_QUEUE_COLUMNS = 3;
const EMPTY_FIELD_NAME = '\u200b';
const QUEUE_LINE_MAX_LENGTH = 120;
const UP_NEXT_FIELD_NAME = 'Up Next';

type QueueField = {
  name: string;
  value: string;
  inline: true;
};

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${mins}:${String(rem).padStart(2, '0')}`;
}

function trimLine(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildQueueColumns(state: GuildPlayerState): QueueField[] {
  if (state.queue.length === 0) {
    return [
      {
        name: UP_NEXT_FIELD_NAME,
        value: 'No upcoming tracks.',
        inline: true
      }
    ];
  }

  const queueItems = state.queue
    .slice(0, QUEUE_PREVIEW_LIMIT)
    .map((track, index) => trimLine(`${index + 1}. ${track.title}`, QUEUE_LINE_MAX_LENGTH));
  const columnCount = Math.min(MAX_QUEUE_COLUMNS, queueItems.length);
  const itemsPerColumn = Math.ceil(queueItems.length / columnCount);

  return Array.from({ length: columnCount }, (_, columnIndex) => {
    const start = columnIndex * itemsPerColumn;
    const end = start + itemsPerColumn;
    const lines = queueItems.slice(start, end);

    return {
      name: columnIndex === 0 ? UP_NEXT_FIELD_NAME : EMPTY_FIELD_NAME,
      value: lines.join('\n'),
      inline: true as const
    };
  });
}

export class PlayerMessageBuilder {
  public build(state: GuildPlayerState): EmbedBuilder[] {
    if (!state.currentTrack) {
      return [this.buildIdleEmbed()];
    }

    const currentTrack = state.currentTrack;
    const nowPlayingEmbed = new EmbedBuilder()
      .setTitle(state.isPaused ? 'Paused' : 'Playing')
      .setDescription(`[${currentTrack.title}](${currentTrack.url})`)
      .setColor(EMBED_COLOR)
      .addFields(
        {
          name: 'Requested By',
          value: currentTrack.requestedByDisplayName,
          inline: true
        },
        {
          name: 'Duration',
          value: formatDuration(currentTrack.durationMs),
          inline: true
        }
      )
      .setFooter({ text: this.buildNowPlayingFooter(state) })
      .setTimestamp();

    if (currentTrack.thumbnailUrl) {
      nowPlayingEmbed.setImage(currentTrack.thumbnailUrl);
    }

    const queueEmbed = new EmbedBuilder()
      .setTitle(`Queue (${state.queue.length})`)
      .setColor(EMBED_COLOR)
      .addFields(buildQueueColumns(state));

    return [nowPlayingEmbed, queueEmbed];
  }

  private buildIdleEmbed(): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle('Present-Mic Music Player')
      .setDescription('Idle. Paste a YouTube URL or type a song name in this channel.')
      .setColor(EMBED_COLOR)
      .addFields(
        {
          name: 'Usage',
          value: 'Post a YouTube video URL, playlist URL, or search text to queue music.'
        },
        {
          name: 'Status',
          value: 'Waiting for music requests.'
        }
      )
      .setTimestamp();
  }

  private buildNowPlayingFooter(state: GuildPlayerState): string {
    return `Queue: ${state.queue.length} | Loop: ${state.loopMode} | Volume: ${state.volume}%`;
  }
}

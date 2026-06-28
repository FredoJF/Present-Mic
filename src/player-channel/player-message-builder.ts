import { EmbedBuilder } from 'discord.js';

import type { GuildPlayerState } from '../music/player-state.js';

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${mins}:${String(rem).padStart(2, '0')}`;
}

export class PlayerMessageBuilder {
  public build(state: GuildPlayerState): EmbedBuilder {
    if (!state.currentTrack) {
      return new EmbedBuilder()
        .setTitle('Present-Mic Music Player')
        .setDescription('Idle. Paste a YouTube URL or type a song name in this channel.')
        .setColor(0x2e8b57)
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

    const queuePreview =
      state.queue.length === 0
        ? 'No upcoming tracks.'
        : state.queue
            .slice(0, 8)
            .map((track, idx) => `${idx + 1}. ${track.title}`)
            .join('\n');

    const embed = new EmbedBuilder()
      .setTitle('Now Playing')
      .setDescription(`[${state.currentTrack.title}](${state.currentTrack.url})`)
      .setColor(state.isPaused ? 0xf39c12 : 0x1abc9c)
      .addFields(
        {
          name: 'Requested By',
          value: state.currentTrack.requestedByDisplayName,
          inline: true
        },
        {
          name: 'Duration',
          value: formatDuration(state.currentTrack.durationMs),
          inline: true
        },
        {
          name: 'Playback',
          value: state.isPaused ? 'Paused' : 'Playing',
          inline: true
        },
        {
          name: `Queue (${state.queue.length})`,
          value: queuePreview
        }
      )
      .setFooter({ text: `Loop: ${state.loopMode} | Volume: ${state.volume}%` })
      .setTimestamp();

    if (state.currentTrack.thumbnailUrl) {
      embed.setThumbnail(state.currentTrack.thumbnailUrl);
    }

    return embed;
  }
}

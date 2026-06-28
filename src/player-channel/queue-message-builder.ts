import type { GuildPlayerState } from '../music/player-state.js';

export function buildQueueText(state: GuildPlayerState): string {
  if (!state.currentTrack && state.queue.length === 0) {
    return 'Queue is currently empty.';
  }

  const nowPlaying = state.currentTrack
    ? `Now: **${state.currentTrack.title}** (${state.currentTrack.requestedByDisplayName})`
    : 'Now: nothing';

  const upcoming =
    state.queue.length === 0
      ? 'No upcoming tracks.'
      : state.queue
          .slice(0, 20)
          .map((track, index) => `${index + 1}. ${track.title} - ${track.requestedByDisplayName}`)
          .join('\n');

  return `${nowPlaying}\n\n${upcoming}`;
}

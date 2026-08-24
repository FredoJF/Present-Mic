export type LoopMode = 'off' | 'track' | 'queue';

export type Track = {
  id: string;
  title: string;
  url: string;
  encodedTrack?: string;
  durationMs: number;
  thumbnailUrl?: string;
  requestedByUserId: string;
  requestedByDisplayName: string;
  source: 'youtube' | 'spotify' | 'deezer' | 'search';
  playlistName?: string;
};

export type GuildPlayerState = {
  guildId: string;
  voiceChannelId: string | null;
  textChannelId: string | null;
  isPlaying: boolean;
  isPaused: boolean;
  loopMode: LoopMode;
  volume: number;
  currentTrack: Track | null;
  history: Track[];
  queue: Track[];
};

export function createIdleState(guildId: string): GuildPlayerState {
  return {
    guildId,
    voiceChannelId: null,
    textChannelId: null,
    isPlaying: false,
    isPaused: false,
    loopMode: 'off',
    volume: 100,
    currentTrack: null,
    history: [],
    queue: []
  };
}

/**
 * Snapshots a state so listeners can hold it across awaits without observing
 * later mutations. Only the arrays are copied, not the tracks inside them:
 * a Track is never mutated after creation, it is only moved between the queue,
 * history, and currentTrack. Deep-copying every track made each snapshot O(queue)
 * in object allocations, which is wasteful on a long playlist since a snapshot is
 * taken on every state change (pause, volume, shuffle, each track transition).
 */
export function clonePlayerState(state: GuildPlayerState): GuildPlayerState {
  return {
    ...state,
    history: [...state.history],
    queue: [...state.queue]
  };
}

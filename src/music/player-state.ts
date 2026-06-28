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
  source: 'youtube' | 'search';
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

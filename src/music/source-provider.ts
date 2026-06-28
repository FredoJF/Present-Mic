import type { Track } from './player-state.js';

export type ResolveInput = {
  guildId: string;
  textChannelId: string;
  voiceChannelId: string;
  query: string;
  requestedByUserId: string;
  requestedByDisplayName: string;
};

export type ResolveResult = {
  tracks: Omit<Track, 'id'>[];
  kind: 'video' | 'playlist' | 'search';
};

export interface SourceProvider {
  resolve(input: ResolveInput): Promise<ResolveResult>;
}

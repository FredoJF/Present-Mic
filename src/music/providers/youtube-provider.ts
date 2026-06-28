import type { ResolveInput, ResolveResult, SourceProvider } from '../source-provider.js';

const YOUTUBE_VIDEO_REGEX =
  /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+(&.*)?$/i;
const YOUTUBE_PLAYLIST_REGEX = /^(https?:\/\/)?(www\.)?youtube\.com\/playlist\?list=[\w-]+/i;

function isVideoUrl(query: string): boolean {
  return YOUTUBE_VIDEO_REGEX.test(query.trim());
}

function isPlaylistUrl(query: string): boolean {
  return YOUTUBE_PLAYLIST_REGEX.test(query.trim());
}

export class YouTubeProvider implements SourceProvider {
  public async resolve(input: ResolveInput): Promise<ResolveResult> {
    const query = input.query.trim();

    if (!query) {
      return {
        kind: 'search',
        tracks: []
      };
    }

    if (isPlaylistUrl(query)) {
      const playlistTracks = Array.from({ length: 5 }, (_, i) => ({
        title: `Playlist Track ${i + 1}`,
        url: query,
        durationMs: 180_000,
        requestedByUserId: input.requestedByUserId,
        requestedByDisplayName: input.requestedByDisplayName,
        source: 'youtube' as const,
        playlistName: 'YouTube Playlist'
      }));

      return {
        kind: 'playlist',
        tracks: playlistTracks
      };
    }

    if (isVideoUrl(query)) {
      return {
        kind: 'video',
        tracks: [
          {
            title: 'YouTube Video',
            url: query,
            durationMs: 210_000,
            requestedByUserId: input.requestedByUserId,
            requestedByDisplayName: input.requestedByDisplayName,
            source: 'youtube'
          }
        ]
      };
    }

    return {
      kind: 'search',
      tracks: [
        {
          title: `Search: ${query}`,
          url: `ytsearch:${query}`,
          durationMs: 200_000,
          requestedByUserId: input.requestedByUserId,
          requestedByDisplayName: input.requestedByDisplayName,
          source: 'search'
        }
      ]
    };
  }
}

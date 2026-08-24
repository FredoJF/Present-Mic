import type { ResolveInput, ResolveResult, SourceProvider } from '../source-provider.js';
import type { LavalinkService } from '../lavalink/lavalink-client.js';
import { DeezerProvider } from './deezer-provider.js';
import { SpotifyProvider } from './spotify-provider.js';

export class LavalinkSourceProvider implements SourceProvider {
  private readonly spotify: SpotifyProvider;
  private readonly deezer: DeezerProvider;

  public constructor(private readonly lavalink: LavalinkService) {
    this.spotify = new SpotifyProvider(lavalink);
    this.deezer = new DeezerProvider(lavalink);
  }

  public async resolve(input: ResolveInput): Promise<ResolveResult> {
    const query = input.query.trim();
    if (!query) {
      return {
        kind: 'search',
        tracks: []
      };
    }

    const normalizedInput = { ...input, query };
    if (this.spotify.supports(query)) {
      return this.spotify.resolve(normalizedInput);
    }

    if (this.deezer.supports(query)) {
      return this.deezer.resolve(normalizedInput);
    }

    return this.lavalink.resolveTracks({
      guildId: normalizedInput.guildId,
      voiceChannelId: normalizedInput.voiceChannelId,
      textChannelId: normalizedInput.textChannelId,
      query,
      requestedByUserId: normalizedInput.requestedByUserId,
      requestedByDisplayName: normalizedInput.requestedByDisplayName
    });
  }
}

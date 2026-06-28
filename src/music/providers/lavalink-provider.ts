import type { ResolveInput, ResolveResult, SourceProvider } from '../source-provider.js';
import type { LavalinkService } from '../lavalink/lavalink-client.js';

export class LavalinkSourceProvider implements SourceProvider {
  public constructor(private readonly lavalink: LavalinkService) {}

  public async resolve(input: ResolveInput): Promise<ResolveResult> {
    const query = input.query.trim();
    if (!query) {
      return {
        kind: 'search',
        tracks: []
      };
    }

    return this.lavalink.resolveTracks({
      guildId: input.guildId,
      voiceChannelId: input.voiceChannelId,
      textChannelId: input.textChannelId,
      query,
      requestedByUserId: input.requestedByUserId,
      requestedByDisplayName: input.requestedByDisplayName
    });
  }
}

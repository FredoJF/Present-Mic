import type { LavalinkService } from '../lavalink/lavalink-client.js';
import type { ResolveInput, ResolveResult, SourceProvider } from '../source-provider.js';

/**
 * Shared bridge for URL-based sources implemented by the LavaSrc Lavalink
 * plugin. Lavalink receives the original URL so it can return every item in
 * an album or playlist instead of the bot trying to expand it itself.
 */
export abstract class LavaSrcUrlProvider implements SourceProvider {
  public constructor(private readonly lavalink: LavalinkService) {}

  public abstract supports(query: string): boolean;

  public async resolve(input: ResolveInput): Promise<ResolveResult> {
    return this.lavalink.resolveTracks({
      guildId: input.guildId,
      voiceChannelId: input.voiceChannelId,
      textChannelId: input.textChannelId,
      query: input.query.trim(),
      requestedByUserId: input.requestedByUserId,
      requestedByDisplayName: input.requestedByDisplayName
    });
  }
}

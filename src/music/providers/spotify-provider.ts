import { LavaSrcUrlProvider } from './lavasrc-url-provider.js';

const SPOTIFY_RESOURCE_TYPES = new Set(['track', 'album', 'playlist', 'artist']);

/** Resolves Spotify URLs through the LavaSrc Spotify source. */
export class SpotifyProvider extends LavaSrcUrlProvider {
  public supports(query: string): boolean {
    try {
      const url = new URL(query.trim());
      if (url.hostname.toLowerCase() !== 'open.spotify.com') {
        return false;
      }

      const pathSegments = url.pathname.split('/').filter(Boolean);
      const resourceType = pathSegments.find((segment) => SPOTIFY_RESOURCE_TYPES.has(segment));
      return resourceType !== undefined;
    } catch {
      return false;
    }
  }
}

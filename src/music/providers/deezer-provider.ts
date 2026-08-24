import { LavaSrcUrlProvider } from './lavasrc-url-provider.js';

const DEEZER_RESOURCE_TYPES = new Set(['track', 'album', 'playlist', 'artist']);

/** Resolves Deezer URLs through the LavaSrc Deezer source. */
export class DeezerProvider extends LavaSrcUrlProvider {
  public supports(query: string): boolean {
    try {
      const url = new URL(query.trim());
      const hostname = url.hostname.toLowerCase();

      // Deezer's short URLs are explicitly supported by LavaSrc.
      if (hostname === 'deezer.page.link') {
        return true;
      }

      if (!hostname.endsWith('deezer.com')) {
        return false;
      }

      return url.pathname
        .split('/')
        .filter(Boolean)
        .some((segment) => DEEZER_RESOURCE_TYPES.has(segment));
    } catch {
      return false;
    }
  }
}

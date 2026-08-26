import {
  LavalinkManager,
  type Player,
  type SearchResult,
  type Track,
  type TrackEndReason
} from 'lavalink-client';
import type { Client } from 'discord.js';

import { env } from '../../config/env.js';
import type { ResolveResult } from '../source-provider.js';
import type { Track as PlayerTrack } from '../player-state.js';
import { logger } from '../../utils/logger.js';

type ResolveTracksInput = {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  query: string;
  requestedByUserId: string;
  requestedByDisplayName: string;
};

type OnTrackEndHandler = (
  guildId: string,
  reason: TrackEndReason | 'trackError' | 'trackStuck'
) => Promise<void> | void;
type OnIdlePlaybackHandler = (guildId: string) => Promise<void> | void;
type OnVoiceConnectionHandler = (
  guildId: string,
  voiceChannelId: string | null,
  reason: 'moved' | 'disconnected' | 'reconnected' | 'rejoin-attempt-failed'
) => Promise<void> | void;

type ResolveAttempt = {
  query: string;
  label: string;
};

// Extra tries per query variant when Lavalink reports a server-side failure.
// Sized for one expired-credential refresh, not for a sustained outage.
const RESOLVE_ERROR_RETRIES = 2;
const RESOLVE_RETRY_DELAY_MS = 500;

// Upper bound on a single Lavalink REST call. Must exceed the slowest realistic
// load, which is a multi-page Spotify playlist combined with a cold anonymous
// token fetch. Worst case a user waits this long per attempt before a retry.
const RESOLVE_REQUEST_TIMEOUT_MS = 30_000;

const NORMALIZATION_MAX_AMPLITUDE = 0.75;
const NORMALIZATION_ADAPTIVE = true;

export class LavalinkService {
  private manager: LavalinkManager | null = null;
  private onTrackEndHandler?: OnTrackEndHandler;
  private onIdlePlaybackHandler?: OnIdlePlaybackHandler;
  private onVoiceConnectionHandler?: OnVoiceConnectionHandler;
  private readonly desiredVoiceChannels = new Map<string, string>();
  private readonly reconnectingGuilds = new Set<string>();
  private readonly normalizationUnavailableNodes = new Set<string>();

  public onTrackEnd(handler: OnTrackEndHandler): void {
    this.onTrackEndHandler = handler;
  }

  public onVoiceConnectionChange(handler: OnVoiceConnectionHandler): void {
    this.onVoiceConnectionHandler = handler;
  }

  public onIdlePlayback(handler: OnIdlePlaybackHandler): void {
    this.onIdlePlaybackHandler = handler;
  }

  public async connect(client: Client): Promise<void> {
    if (this.manager) {
      return;
    }

    const manager = new LavalinkManager({
      nodes: [
        {
          id: 'main',
          host: env.LAVALINK_HOST,
          port: env.LAVALINK_PORT,
          authorization: env.LAVALINK_PASSWORD,
          secure: env.LAVALINK_SECURE,
          retryAmount: 10,
          retryDelay: 5000,
          // lavalink-client defaults this to 10s, which is shorter than a large
          // Spotify playlist takes to load: LavaSrc pages the playlist and, on a
          // 401 from the v1 API, fetches an anonymous token through
          // spotify-tokener, whose headless Chrome start is not instant. When the
          // signal fired first, Lavalink finished the load anyway and then failed
          // to write the response ("Broken pipe"), so the work was done and
          // thrown away on every attempt.
          requestSignalTimeoutMS: RESOLVE_REQUEST_TIMEOUT_MS
        }
      ],
      sendToShard: (guildId, payload) => {
        const guild = client.guilds.cache.get(guildId);
        guild?.shard?.send(payload);
      },
      autoSkip: false,
      playerOptions: {
        defaultSearchPlatform: 'ytsearch',
        onDisconnect: {
          autoReconnect: true,
          autoReconnectOnlyWithTracks: true,
          destroyPlayer: false
        },
        onEmptyQueue: {
          destroyAfterMs: 120_000
        }
      }
    });

    manager.nodeManager.on('connect', (node) => {
      logger.info({ nodeId: node.id }, 'Connected to Lavalink node');
    });

    manager.nodeManager.on('error', (node, error) => {
      logger.error({ nodeId: node.id, error }, 'Lavalink node error');
    });

    manager.on('trackEnd', async (player, track, payload) => {
      logger.info(
        {
          guildId: player.guildId,
          reason: payload.reason,
          title: track?.info?.title ?? null,
          remainingQueueLength: player.queue.tracks.length
        },
        'Lavalink track end'
      );
      await this.onTrackEndHandler?.(player.guildId, payload.reason);
    });

    manager.on('trackError', async (player, track, payload) => {
      const title = track?.info.title ?? 'unknown';
      const url = track?.info.uri ?? 'unknown';

      const rawMessage =
        typeof payload === 'object' && payload !== null && 'exception' in payload
          ? (payload.exception as { message?: string } | undefined)?.message
          : undefined;

      const isGeoBlocked = rawMessage
        ?.toLowerCase()
        .includes('not made this video available in your country');

      if (isGeoBlocked) {
        logger.warn(
          {
            guildId: player.guildId,
            title,
            url,
            reason: 'geo-blocked'
          },
          'Lavalink track unavailable in this region'
        );
      } else {
        logger.error(
          {
            guildId: player.guildId,
            title,
            url,
            errorMessage: rawMessage
          },
          'Lavalink track error'
        );
      }

      await this.onTrackEndHandler?.(player.guildId, 'trackError');
    });

    manager.on('trackStuck', async (player, track, payload) => {
      logger.warn({ guildId: player.guildId, track, payload }, 'Lavalink track stuck');
      await this.onTrackEndHandler?.(player.guildId, 'trackStuck');
    });

    manager.on('playerMove', async (player, oldVoiceChannelId, newVoiceChannelId) => {
      logger.info(
        { guildId: player.guildId, oldVoiceChannelId, newVoiceChannelId },
        'Player moved to another voice channel'
      );
      this.desiredVoiceChannels.set(player.guildId, newVoiceChannelId);
      await this.onVoiceConnectionHandler?.(player.guildId, newVoiceChannelId, 'moved');
    });

    manager.on('playerDisconnect', async (player, voiceChannelId) => {
      logger.warn(
        { guildId: player.guildId, voiceChannelId },
        'Player disconnected from voice channel'
      );
      await this.onVoiceConnectionHandler?.(player.guildId, null, 'disconnected');
      void this.tryRejoinPlayer(player.guildId, voiceChannelId);
    });

    manager.on('playerReconnect', async (player, voiceChannelId) => {
      logger.info(
        { guildId: player.guildId, voiceChannelId },
        'Player reconnected to voice channel'
      );
      this.desiredVoiceChannels.set(player.guildId, voiceChannelId);
      await this.onVoiceConnectionHandler?.(player.guildId, voiceChannelId, 'reconnected');
    });

    // Lavalink emits playerUpdate on a timer (roughly every 5s) for every active
    // player. Only the idle transition is actionable, so the common case must not
    // build a log record or await anything.
    manager.on('playerUpdate', async (_oldPlayerJson, player) => {
      if (player.playing || player.paused || player.queue.current) {
        return;
      }

      logger.warn(
        { guildId: player.guildId },
        'Lavalink player is idle, invoking idle playback handler'
      );
      await this.onIdlePlaybackHandler?.(player.guildId);
    });

    client.on('raw', (packet) => {
      void manager.sendRawData(packet as never).catch((error) => {
        logger.error({ error }, 'Failed to forward raw voice packet to lavalink');
      });
    });

    this.manager = manager;

    if (client.user) {
      await manager.init({ id: client.user.id, username: client.user.username });
      return;
    }

    client.once('clientReady', () => {
      if (!client.user) {
        return;
      }
      void manager.init({ id: client.user.id, username: client.user.username }).catch((error) => {
        logger.error({ error }, 'Failed to initialize lavalink manager on ready');
      });
    });
  }

  public async resolveTracks(input: ResolveTracksInput): Promise<ResolveResult> {
    logger.info({ guildId: input.guildId, query: input.query }, 'Resolving tracks via Lavalink');
    const player = await this.ensurePlayer(
      input.guildId,
      input.voiceChannelId,
      input.textChannelId
    );
    const attempts = this.buildResolveAttempts(input.query);

    let response: SearchResult | null = null;
    let lastError: unknown;

    for (const attempt of attempts) {
      const outcome = await this.runResolveAttempt(player, input, attempt);

      if (outcome.error) {
        lastError = outcome.error;
      }

      if (outcome.response) {
        response = outcome.response;
        if (response.tracks.length > 0) {
          break;
        }
      }
    }

    // An `error` load type never becomes `response`, so a server-side failure is
    // reported with its own reason instead of being flattened into the generic
    // "no playable tracks" message, which used to hide Spotify token failures.
    if (!response || response.tracks.length === 0) {
      if (lastError) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      }

      throw new Error('No playable tracks were found for this input');
    }

    const kind: ResolveResult['kind'] =
      response.loadType === 'playlist'
        ? 'playlist'
        : input.query.startsWith('http')
          ? 'video'
          : 'search';
    const playlistName = response.playlist?.name;
    const resolvedTracks = kind === 'search' ? response.tracks.slice(0, 1) : response.tracks;

    const tracks = resolvedTracks.map((track) => this.toPlayerTrack(track, input, playlistName));

    return {
      kind,
      tracks
    };
  }

  /**
   * True when a request was cut off locally rather than answered by Lavalink.
   * lavalink-client aborts via AbortSignal.timeout, which surfaces as a
   * DOMException named TimeoutError.
   */
  private isAbortError(error: unknown): boolean {
    return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  }

  /**
   * Runs one query variant, retrying only on server-side failures.
   *
   * A `loadType: 'error'` means the request reached Lavalink and something broke
   * behind it — most often an expired upstream credential. LavaSrc caches its
   * Spotify anonymous token and only refreshes after a rejected call, so the
   * first paste of a link following an idle period fails while the retry
   * succeeds. Retrying here absorbs that instead of surfacing it to the user.
   *
   * Empty results are never retried: those mean the query genuinely matched
   * nothing, and retrying would only add latency to every real miss.
   *
   * Timeouts are not retried either. When the signal fires, Lavalink usually
   * carries on and completes the load, then fails to write to a closed socket —
   * so a retry duplicates expensive upstream work that may already have
   * succeeded, and multiplies how long the user waits for a failure. Better to
   * fail fast and let them paste the link again.
   */
  private async runResolveAttempt(
    player: Player,
    input: ResolveTracksInput,
    attempt: ResolveAttempt
  ): Promise<{ response: SearchResult | null; error: unknown }> {
    let error: unknown;

    for (let tryIndex = 0; tryIndex <= RESOLVE_ERROR_RETRIES; tryIndex += 1) {
      try {
        const result = (await player.search(
          {
            query: attempt.query
          },
          {
            id: input.requestedByUserId,
            displayName: input.requestedByDisplayName
          },
          false
        )) as SearchResult;

        logger.info(
          {
            guildId: input.guildId,
            attempt: attempt.label,
            attemptQuery: attempt.query,
            loadType: result.loadType,
            tracks: result.tracks.length,
            tryIndex
          },
          'Resolved tracks via Lavalink attempt'
        );

        if (result.loadType !== 'error') {
          return { response: result, error };
        }

        error = new Error(result.exception?.message ?? 'Lavalink could not resolve this input');
      } catch (thrown) {
        error = thrown;
      }

      const timedOut = this.isAbortError(error);
      const willRetry = !timedOut && tryIndex < RESOLVE_ERROR_RETRIES;

      logger.warn(
        {
          guildId: input.guildId,
          attempt: attempt.label,
          attemptQuery: attempt.query,
          tryIndex,
          timedOut,
          willRetry,
          error
        },
        'Lavalink resolve attempt failed'
      );

      if (!willRetry) {
        break;
      }

      await this.wait(RESOLVE_RETRY_DELAY_MS * (tryIndex + 1));
    }

    return { response: null, error };
  }

  private buildResolveAttempts(rawQuery: string): ResolveAttempt[] {
    const query = rawQuery.trim();
    const attempts: ResolveAttempt[] = [];
    const seen = new Set<string>();

    const pushAttempt = (attemptQuery: string, label: string): void => {
      const normalized = attemptQuery.trim();
      if (!normalized || seen.has(normalized)) {
        return;
      }

      seen.add(normalized);
      attempts.push({ query: normalized, label });
    };

    const canonicalYoutubeUrl = this.toCanonicalYoutubeWatchUrl(query);
    if (canonicalYoutubeUrl && canonicalYoutubeUrl !== query) {
      pushAttempt(canonicalYoutubeUrl, 'canonical-youtube-url');
    }

    pushAttempt(query, 'original');

    const youtubeVideoId = this.extractYoutubeVideoId(query);
    if (youtubeVideoId) {
      pushAttempt(`https://www.youtube.com/watch?v=${youtubeVideoId}`, 'youtube-watch-url');
      pushAttempt(`https://youtu.be/${youtubeVideoId}`, 'youtube-short-url');
    }

    return attempts;
  }

  private extractYoutubeVideoId(query: string): string | null {
    if (!query.toLowerCase().startsWith('http')) {
      return null;
    }

    try {
      const url = new URL(query);
      const hostname = url.hostname.toLowerCase();
      if (hostname === 'youtu.be') {
        return url.pathname.slice(1) || null;
      }

      if (hostname.endsWith('youtube.com') || hostname.endsWith('youtube-nocookie.com')) {
        const directId = url.searchParams.get('v');
        if (directId) {
          return directId;
        }

        const pathMatch = url.pathname.match(/^\/shorts\/([\w-]+)/i);
        if (pathMatch?.[1]) {
          return pathMatch[1];
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private toCanonicalYoutubeWatchUrl(query: string): string | null {
    const videoId = this.extractYoutubeVideoId(query);
    if (!videoId) {
      return null;
    }

    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  private getRequestedSource(query: string, resolvedSourceName: string): PlayerTrack['source'] {
    const normalizedQuery = query.toLowerCase();

    if (normalizedQuery.includes('open.spotify.com/') || normalizedQuery.startsWith('spsearch:')) {
      return 'spotify';
    }

    if (
      normalizedQuery.includes('deezer.com/') ||
      normalizedQuery.includes('deezer.page.link/') ||
      normalizedQuery.startsWith('dzsearch:')
    ) {
      return 'deezer';
    }

    return resolvedSourceName.includes('youtube') ? 'youtube' : 'search';
  }

  public async play(
    guildId: string,
    voiceChannelId: string,
    textChannelId: string,
    track: PlayerTrack
  ): Promise<void> {
    logger.info(
      { guildId, title: track.title, url: track.url, voiceChannelId, textChannelId },
      'Sending play request to Lavalink'
    );
    const player = await this.ensurePlayer(guildId, voiceChannelId, textChannelId);

    if (track.encodedTrack) {
      await player.play({
        track: {
          encoded: track.encodedTrack,
          requester: {
            id: track.requestedByUserId,
            displayName: track.requestedByDisplayName
          }
        }
      });
      return;
    }

    const response = (await player.search(
      {
        query: track.url
      },
      {
        id: track.requestedByUserId,
        displayName: track.requestedByDisplayName
      },
      true
    )) as SearchResult;

    const first = response.tracks.at(0);
    if (!first) {
      throw new Error('No playable track returned by lavalink search');
    }

    await player.play({ clientTrack: first });
  }

  public async pause(guildId: string): Promise<void> {
    const player = this.manager?.getPlayer(guildId);
    if (!player) {
      return;
    }
    await player.pause();
  }

  public async resume(guildId: string): Promise<void> {
    const player = this.manager?.getPlayer(guildId);
    if (!player) {
      return;
    }
    await player.resume();
  }

  public async stop(guildId: string): Promise<void> {
    const player = this.manager?.getPlayer(guildId);
    if (!player) {
      return;
    }

    await player.stopPlaying(true, false);
    await player.destroy('manual-stop', true);
  }

  public async destroy(guildId: string): Promise<void> {
    const player = this.manager?.getPlayer(guildId);
    if (!player) {
      return;
    }

    await player.destroy('queue-ended', true);
  }

  public async setVolume(guildId: string, volume: number): Promise<void> {
    const player = this.manager?.getPlayer(guildId);
    if (!player) {
      return;
    }
    await player.setVolume(volume);
  }

  public getVoiceChannelId(guildId: string): string | null {
    return this.manager?.getPlayer(guildId)?.voiceChannelId ?? null;
  }

  public getTextChannelId(guildId: string): string | null {
    return this.manager?.getPlayer(guildId)?.textChannelId ?? null;
  }

  public isPlaybackIdle(guildId: string): boolean {
    const player = this.manager?.getPlayer(guildId);
    if (!player) {
      return true;
    }

    return !player.playing && !player.paused && !player.queue.current;
  }

  private async ensurePlayer(guildId: string, voiceChannelId: string, textChannelId: string) {
    const manager = this.manager;
    if (!manager) {
      throw new Error('Lavalink manager is not initialized');
    }

    this.desiredVoiceChannels.set(guildId, voiceChannelId);

    const player = manager.createPlayer({
      guildId,
      voiceChannelId,
      textChannelId,
      selfDeaf: true,
      volume: 100
    });

    if (player.voiceChannelId !== voiceChannelId) {
      await player.changeVoiceState({ voiceChannelId });
    }

    if (!player.connected) {
      await player.connect();
    }

    await this.applyDefaultAudioFilters(player);
    return player;
  }

  private async applyDefaultAudioFilters(player: Player): Promise<void> {
    if (player.filterManager.filters.lavalinkLavaDspxPlugin.normalization) {
      return;
    }

    const nodeId = player.node.id;
    if (this.normalizationUnavailableNodes.has(nodeId)) {
      return;
    }

    const hasNormalizationFilter = player.node.info?.filters?.includes('normalization');
    const hasLavaDspxPlugin = player.node.info?.plugins?.some(
      (plugin) => plugin.name === 'lavadspx-plugin'
    );

    if (!hasNormalizationFilter || !hasLavaDspxPlugin) {
      this.normalizationUnavailableNodes.add(nodeId);
      logger.info(
        {
          guildId: player.guildId,
          nodeId,
          hasNormalizationFilter: Boolean(hasNormalizationFilter),
          hasLavaDspxPlugin: Boolean(hasLavaDspxPlugin)
        },
        'Skipping audio normalization because the Lavalink node does not support it'
      );
      return;
    }

    try {
      await player.filterManager.lavalinkLavaDspxPlugin.toggleNormalization(
        NORMALIZATION_MAX_AMPLITUDE,
        NORMALIZATION_ADAPTIVE
      );
      logger.info(
        {
          guildId: player.guildId,
          nodeId,
          maxAmplitude: NORMALIZATION_MAX_AMPLITUDE,
          adaptive: NORMALIZATION_ADAPTIVE
        },
        'Enabled audio normalization filter'
      );
    } catch (error) {
      this.normalizationUnavailableNodes.add(nodeId);
      logger.warn(
        { error, guildId: player.guildId, nodeId },
        'Failed to enable audio normalization filter'
      );
    }
  }

  private async tryRejoinPlayer(guildId: string, disconnectedChannelId: string): Promise<void> {
    const manager = this.manager;
    if (!manager || this.reconnectingGuilds.has(guildId)) {
      return;
    }

    const player = manager.getPlayer(guildId);
    if (!player) {
      return;
    }

    const hasPlaybackContext = Boolean(
      player.queue.current || player.queue.tracks.length > 0 || player.playing
    );
    if (!hasPlaybackContext) {
      return;
    }

    const targetVoiceChannel = this.desiredVoiceChannels.get(guildId) ?? disconnectedChannelId;
    if (!targetVoiceChannel) {
      return;
    }

    this.reconnectingGuilds.add(guildId);
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          if (player.voiceChannelId !== targetVoiceChannel) {
            await player.changeVoiceState({ voiceChannelId: targetVoiceChannel });
          }
          await player.connect();
          this.desiredVoiceChannels.set(guildId, targetVoiceChannel);
          await this.onVoiceConnectionHandler?.(guildId, targetVoiceChannel, 'reconnected');
          logger.info({ guildId, targetVoiceChannel, attempt }, 'Rejoin attempt succeeded');
          return;
        } catch (error) {
          logger.warn({ guildId, targetVoiceChannel, attempt, error }, 'Rejoin attempt failed');
          await this.wait(1200 * attempt);
        }
      }

      await this.onVoiceConnectionHandler?.(guildId, null, 'rejoin-attempt-failed');
    } finally {
      this.reconnectingGuilds.delete(guildId);
    }
  }

  private async wait(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), ms);
    });
  }

  private toPlayerTrack(
    track: Track,
    input: ResolveTracksInput,
    playlistName?: string
  ): Omit<PlayerTrack, 'id'> {
    const base: Omit<PlayerTrack, 'id'> = {
      title: track.info.title,
      url: track.info.uri,
      durationMs: track.info.duration,
      requestedByUserId: input.requestedByUserId,
      requestedByDisplayName: input.requestedByDisplayName,
      // Spotify tracks are normally mirrored to Deezer or YouTube by LavaSrc.
      // Keep the requested provider so the queue remains accurate to the URL
      // the user supplied rather than the mirror chosen by Lavalink.
      source: this.getRequestedSource(input.query, track.info.sourceName)
    };

    if (track.encoded) {
      base.encodedTrack = track.encoded;
    }

    if (track.info.artworkUrl) {
      base.thumbnailUrl = track.info.artworkUrl;
    }

    if (playlistName) {
      base.playlistName = playlistName;
    }

    return base;
  }
}

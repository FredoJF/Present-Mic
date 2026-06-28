import { LavalinkManager, type SearchResult, type Track, type TrackEndReason } from 'lavalink-client';
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

type OnTrackEndHandler = (guildId: string, reason: TrackEndReason | 'trackError' | 'trackStuck') => Promise<void> | void;
type OnIdlePlaybackHandler = (guildId: string) => Promise<void> | void;
type OnVoiceConnectionHandler = (
  guildId: string,
  voiceChannelId: string | null,
  reason: 'moved' | 'disconnected' | 'reconnected' | 'rejoin-attempt-failed'
) => Promise<void> | void;

export class LavalinkService {
  private manager: LavalinkManager | null = null;
  private onTrackEndHandler?: OnTrackEndHandler;
  private onIdlePlaybackHandler?: OnIdlePlaybackHandler;
  private onVoiceConnectionHandler?: OnVoiceConnectionHandler;
  private readonly desiredVoiceChannels = new Map<string, string>();
  private readonly reconnectingGuilds = new Set<string>();

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
          retryDelay: 5000
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

      const isGeoBlocked = rawMessage?.toLowerCase().includes('not made this video available in your country');

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
      logger.warn({ guildId: player.guildId, voiceChannelId }, 'Player disconnected from voice channel');
      await this.onVoiceConnectionHandler?.(player.guildId, null, 'disconnected');
      void this.tryRejoinPlayer(player.guildId, voiceChannelId);
    });

    manager.on('playerReconnect', async (player, voiceChannelId) => {
      logger.info({ guildId: player.guildId, voiceChannelId }, 'Player reconnected to voice channel');
      this.desiredVoiceChannels.set(player.guildId, voiceChannelId);
      await this.onVoiceConnectionHandler?.(player.guildId, voiceChannelId, 'reconnected');
    });

    manager.on('playerUpdate', async (_oldPlayerJson, player) => {
      logger.info(
        {
          guildId: player.guildId,
          playing: player.playing,
          paused: player.paused,
          position: player.position,
          hasCurrent: Boolean(player.queue.current),
          queuedTracks: player.queue.tracks.length
        },
        'Lavalink player update'
      );

      if (player.playing || player.paused || player.queue.current) {
        return;
      }

      logger.warn({ guildId: player.guildId }, 'Lavalink player is idle, invoking idle playback handler');
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
    const player = await this.ensurePlayer(input.guildId, input.voiceChannelId, input.textChannelId);
    const response = (await player.search(
      {
        query: input.query
      },
      {
        id: input.requestedByUserId,
        displayName: input.requestedByDisplayName
      },
      false
    )) as SearchResult;

    const kind: ResolveResult['kind'] = response.loadType === 'playlist' ? 'playlist' : input.query.startsWith('http') ? 'video' : 'search';
    const playlistName = response.playlist?.name;

    const tracks = response.tracks.map((track) => this.toPlayerTrack(track, input, playlistName));

    return {
      kind,
      tracks
    };
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

    return player;
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

    const hasPlaybackContext = Boolean(player.queue.current || player.queue.tracks.length > 0 || player.playing);
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

  private toPlayerTrack(track: Track, input: ResolveTracksInput, playlistName?: string): Omit<PlayerTrack, 'id'> {
    const base: Omit<PlayerTrack, 'id'> = {
      title: track.info.title,
      url: track.info.uri,
      durationMs: track.info.duration,
      requestedByUserId: input.requestedByUserId,
      requestedByDisplayName: input.requestedByDisplayName,
      source: track.info.sourceName.includes('youtube') ? 'youtube' : 'search'
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

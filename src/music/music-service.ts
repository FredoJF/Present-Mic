import type { GuildPlayerState, LoopMode, Track } from './player-state.js';
import { createIdleState } from './player-state.js';
import { QueueService } from './queue-service.js';
import type { SourceProvider } from './source-provider.js';
import type { LavalinkService } from './lavalink/lavalink-client.js';
import { logger } from '../utils/logger.js';

export type AddTrackInput = {
  guildId: string;
  textChannelId: string;
  voiceChannelId: string;
  query: string;
  requestedByUserId: string;
  requestedByDisplayName: string;
};

export class MusicService {
  private readonly states = new Map<string, GuildPlayerState>();
  private readonly queue = new QueueService();
  private readonly stateListeners = new Set<(guildId: string, state: GuildPlayerState) => Promise<void> | void>();
  private readonly manualStopGuilds = new Set<string>();
  private readonly advancingGuilds = new Set<string>();
  private readonly trackWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

  public constructor(
    private readonly sourceProvider: SourceProvider,
    private readonly lavalink: LavalinkService
  ) {
    this.lavalink.onTrackEnd(async (guildId, reason) => {
      if (reason === 'replaced') {
        return;
      }

      // Some Lavalink flows report a natural transition as "stopped".
      // Only suppress auto-advance when stop was explicitly user-triggered.
      if (reason === 'stopped' && this.manualStopGuilds.has(guildId)) {
        return;
      }

      await this.advanceToNextTrack(guildId, reason);
    });

    this.lavalink.onIdlePlayback(async (guildId) => {
      const state = this.getState(guildId);
      if (state.queue.length === 0 || this.manualStopGuilds.has(guildId)) {
        return;
      }

      logger.warn(
        { guildId, queueLength: state.queue.length, currentTrack: state.currentTrack?.title ?? null },
        'Detected idle Lavalink player with queued tracks, forcing auto-advance'
      );

      await this.advanceToNextTrack(guildId, 'playerUpdate-idle');
    });

    this.lavalink.onVoiceConnectionChange(async (guildId, voiceChannelId, reason) => {
      const state = this.getState(guildId);

      // Preserve last known voice channel when disconnect reports null,
      // so queue transitions can still reconnect and continue playback.
      if (voiceChannelId) {
        state.voiceChannelId = voiceChannelId;
      } else if (reason === 'rejoin-attempt-failed') {
        state.voiceChannelId = null;
      }

      if (reason === 'disconnected') {
        state.isPlaying = false;
      }

      if (reason === 'reconnected' && state.currentTrack && !state.isPaused) {
        state.isPlaying = true;
      }

      logger.info(
        {
          guildId,
          reason,
          reportedVoiceChannelId: voiceChannelId,
          stateVoiceChannelId: state.voiceChannelId,
          isPlaying: state.isPlaying,
          isPaused: state.isPaused,
          currentTrack: state.currentTrack?.title ?? null,
          queueLength: state.queue.length
        },
        'Voice connection state changed'
      );

      this.emitStateChange(guildId);
    });
  }

  public onStateChange(
    listener: (guildId: string, state: GuildPlayerState) => Promise<void> | void
  ): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  public getState(guildId: string): GuildPlayerState {
    const existing = this.states.get(guildId);
    if (existing) {
      return existing;
    }

    const initial = createIdleState(guildId);
    this.states.set(guildId, initial);
    return initial;
  }

  public resetToIdle(guildId: string): GuildPlayerState {
    const next = createIdleState(guildId);
    this.states.set(guildId, next);
    this.emitStateChange(guildId);
    return next;
  }

  public async addFromInput(input: AddTrackInput): Promise<{ added: Track[]; kind: string }> {
    const state = this.getState(input.guildId);
    logger.info(
      {
        guildId: input.guildId,
        query: input.query,
        requester: input.requestedByDisplayName,
        currentTrack: state.currentTrack?.title ?? null,
        queueLength: state.queue.length,
        stateVoiceChannelId: state.voiceChannelId,
        inputVoiceChannelId: input.voiceChannelId
      },
      'Received add track request'
    );
    state.textChannelId = input.textChannelId;

    const hasActivePlaybackContext = Boolean(
      state.currentTrack || state.queue.length > 0 || state.isPlaying || state.isPaused
    );

    // Keep the current playback voice channel stable while music is active.
    // This avoids accidental player moves/stops when someone queues from another channel.
    const activeVoiceChannelId =
      hasActivePlaybackContext && state.voiceChannelId ? state.voiceChannelId : input.voiceChannelId;

    state.voiceChannelId = activeVoiceChannelId;

    const resolved = await this.sourceProvider.resolve({
      guildId: input.guildId,
      textChannelId: input.textChannelId,
      voiceChannelId: activeVoiceChannelId,
      query: input.query,
      requestedByUserId: input.requestedByUserId,
      requestedByDisplayName: input.requestedByDisplayName
    });

    logger.info(
      {
        guildId: input.guildId,
        kind: resolved.kind,
        resolvedTracks: resolved.tracks.length,
        activeVoiceChannelId
      },
      'Resolved tracks from source provider'
    );

    const added = this.queue.addTracks(state, resolved.tracks);

    logger.info(
      {
        guildId: input.guildId,
        addedTracks: added.length,
        queueLength: state.queue.length,
        hasCurrentTrack: Boolean(state.currentTrack)
      },
      'Added tracks to queue'
    );

    if (!state.currentTrack && added.length > 0) {
      logger.info({ guildId: input.guildId }, 'No current track, triggering immediate playNext');
      await this.playNext(input.guildId);
    } else {
      logger.info({ guildId: input.guildId }, 'Track queued while player already active');
      this.emitStateChange(input.guildId);
    }

    return {
      added,
      kind: resolved.kind
    };
  }

  public async playNext(guildId: string): Promise<Track | null> {
    const state = this.getState(guildId);

    this.clearTrackWatchdog(guildId);

    logger.info(
      {
        guildId,
        loopMode: state.loopMode,
        currentTrack: state.currentTrack?.title ?? null,
        queueLength: state.queue.length,
        voiceChannelId: state.voiceChannelId,
        textChannelId: state.textChannelId
      },
      'playNext invoked'
    );

    if (state.loopMode === 'track' && state.currentTrack) {
      if (!state.voiceChannelId || !state.textChannelId) {
        return null;
      }

      await this.lavalink.play(guildId, state.voiceChannelId, state.textChannelId, state.currentTrack);
      state.isPlaying = true;
      state.isPaused = false;
      this.emitStateChange(guildId);
      return state.currentTrack;
    }

    if (state.loopMode === 'queue' && state.currentTrack) {
      state.queue.push(state.currentTrack);
    }

    const next = this.queue.popNext(state);
    if (!next) {
      logger.info({ guildId }, 'Queue empty in playNext, destroying player');
      await this.lavalink.destroy(guildId).catch((error) => {
        logger.warn({ error, guildId }, 'Failed to destroy lavalink player after queue end');
      });

      state.currentTrack = null;
      state.isPlaying = false;
      state.isPaused = false;
      state.voiceChannelId = null;
      this.emitStateChange(guildId);
      return null;
    }

    logger.info({ guildId, nextTitle: next.title, remainingQueueLength: state.queue.length }, 'Selected next track');

    if (!state.voiceChannelId) {
      state.voiceChannelId = this.lavalink.getVoiceChannelId(guildId);
    }

    if (!state.textChannelId) {
      state.textChannelId = this.lavalink.getTextChannelId(guildId);
    }

    if (!state.voiceChannelId || !state.textChannelId) {
      logger.warn(
        {
          guildId,
          reason: 'missing-playback-context',
          hasCurrentTrack: Boolean(state.currentTrack),
          queueLength: state.queue.length,
          voiceChannelId: state.voiceChannelId,
          textChannelId: state.textChannelId
        },
        'Cannot play next track because playback channel context is missing'
      );
      state.isPlaying = false;
      state.isPaused = false;
      this.emitStateChange(guildId);
      return null;
    }

    await this.lavalink.play(guildId, state.voiceChannelId, state.textChannelId, next);
    logger.info({ guildId, title: next.title }, 'Started next track playback');
    this.scheduleTrackWatchdog(guildId, next);
    state.isPlaying = true;
    state.isPaused = false;
    this.emitStateChange(guildId);
    return next;
  }

  public async playPrevious(guildId: string): Promise<Track | null> {
    const state = this.getState(guildId);
    const prev = this.queue.popPrevious(state);
    if (!prev) {
      return null;
    }

    if (!state.voiceChannelId || !state.textChannelId) {
      return null;
    }

    await this.lavalink.play(guildId, state.voiceChannelId, state.textChannelId, prev);
    state.isPlaying = true;
    state.isPaused = false;
    this.emitStateChange(guildId);
    return prev;
  }

  public async pause(guildId: string): Promise<void> {
    const state = this.getState(guildId);
    if (!state.currentTrack || state.isPaused) {
      return;
    }

    await this.lavalink.pause(guildId);
    state.isPaused = true;
    state.isPlaying = false;
    this.emitStateChange(guildId);
  }

  public async resume(guildId: string): Promise<void> {
    const state = this.getState(guildId);
    if (!state.currentTrack || !state.isPaused) {
      return;
    }

    await this.lavalink.resume(guildId);
    state.isPaused = false;
    state.isPlaying = true;
    this.emitStateChange(guildId);
  }

  public async stop(guildId: string): Promise<void> {
    const state = this.getState(guildId);
    this.clearTrackWatchdog(guildId);
    this.manualStopGuilds.add(guildId);
    try {
      await this.lavalink.stop(guildId);
      state.currentTrack = null;
      state.queue = [];
      state.history = [];
      state.isPlaying = false;
      state.isPaused = false;
      this.emitStateChange(guildId);
    } finally {
      this.manualStopGuilds.delete(guildId);
    }
  }

  public shuffle(guildId: string): void {
    const state = this.getState(guildId);
    this.queue.shuffle(state);
    this.emitStateChange(guildId);
  }

  public clearQueue(guildId: string): void {
    const state = this.getState(guildId);
    this.queue.clear(state);
    this.emitStateChange(guildId);
  }

  public removeQueueItem(guildId: string, index: number): Track | null {
    const state = this.getState(guildId);
    const removed = this.queue.removeAt(state, index);
    this.emitStateChange(guildId);
    return removed;
  }

  public setLoopMode(guildId: string, loopMode: LoopMode): LoopMode {
    const state = this.getState(guildId);
    state.loopMode = loopMode;
    this.emitStateChange(guildId);
    return state.loopMode;
  }

  public setVolume(guildId: string, volume: number): number {
    const state = this.getState(guildId);
    const bounded = Math.max(0, Math.min(200, volume));
    state.volume = bounded;
    void this.lavalink.setVolume(guildId, bounded);
    this.emitStateChange(guildId);
    return bounded;
  }

  private emitStateChange(guildId: string): void {
    const state = this.getState(guildId);
    for (const listener of this.stateListeners) {
      Promise.resolve(listener(guildId, state)).catch((error) => {
        logger.error({ error, guildId }, 'MusicService state listener failed');
      });
    }
  }

  private async advanceToNextTrack(guildId: string, reason: string): Promise<void> {
    if (this.advancingGuilds.has(guildId)) {
      logger.debug({ guildId, reason }, 'Skipping duplicate auto-advance while another transition is running');
      return;
    }

    this.advancingGuilds.add(guildId);
    try {
      logger.info({ guildId, reason }, 'Auto-advancing to next track');
      const next = await this.playNext(guildId);
      logger.info({ guildId, reason, advanced: Boolean(next), nextTitle: next?.title ?? null }, 'Auto-advance result');
    } catch (error) {
      logger.error({ error, guildId, reason }, 'Failed to chain next track after track end event');
    } finally {
      this.advancingGuilds.delete(guildId);
    }
  }

  private scheduleTrackWatchdog(guildId: string, track: Track): void {
    const safetyMs = 1500;
    const waitMs = Math.max(2500, track.durationMs + safetyMs);

    const timeout = setTimeout(() => {
      const state = this.getState(guildId);
      const stillOnSameTrack = state.currentTrack?.id === track.id;
      const hasNext = state.queue.length > 0;

      if (!stillOnSameTrack || state.isPaused || !hasNext) {
        return;
      }

      logger.warn(
        {
          guildId,
          currentTrack: state.currentTrack?.title ?? null,
          queueLength: state.queue.length,
          expectedDurationMs: track.durationMs
        },
        'Track-end watchdog triggered fallback auto-advance'
      );

      void this.advanceToNextTrack(guildId, 'watchdog-timeout');
    }, waitMs);

    this.trackWatchdogs.set(guildId, timeout);
  }

  private clearTrackWatchdog(guildId: string): void {
    const existing = this.trackWatchdogs.get(guildId);
    if (!existing) {
      return;
    }

    clearTimeout(existing);
    this.trackWatchdogs.delete(guildId);
  }
}

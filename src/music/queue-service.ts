import { randomUUID } from 'node:crypto';

import type { GuildPlayerState, Track } from './player-state.js';

export class QueueService {
  public addTracks(state: GuildPlayerState, tracks: Omit<Track, 'id'>[]): Track[] {
    const resolved = tracks.map((t) => ({ ...t, id: randomUUID() }));
    state.queue.push(...resolved);
    return resolved;
  }

  public popNext(state: GuildPlayerState): Track | null {
    const next = state.queue.shift();
    if (!next) {
      return null;
    }

    if (state.currentTrack) {
      state.history.unshift(state.currentTrack);
    }

    state.currentTrack = next;
    return next;
  }

  public popPrevious(state: GuildPlayerState): Track | null {
    const prev = state.history.shift();
    if (!prev) {
      return null;
    }

    if (state.currentTrack) {
      state.queue.unshift(state.currentTrack);
    }

    state.currentTrack = prev;
    return prev;
  }

  public clear(state: GuildPlayerState): void {
    state.queue = [];
  }

  public removeAt(state: GuildPlayerState, index: number): Track | null {
    if (index < 0 || index >= state.queue.length) {
      return null;
    }

    const [removed] = state.queue.splice(index, 1);
    return removed ?? null;
  }

  public shuffle(state: GuildPlayerState): void {
    for (let i = state.queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const current = state.queue[i];
      const target = state.queue[j];
      if (!current || !target) {
        continue;
      }
      state.queue[i] = target;
      state.queue[j] = current;
    }
  }
}

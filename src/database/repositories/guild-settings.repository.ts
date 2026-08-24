import type { GuildSettings } from '@prisma/client';

import { prisma } from '../prisma.js';

export type GuildSettingsPatch = {
  playerChannelId?: string | null;
  playerMessageId?: string | null;
  djRoleId?: string | null;
};

/**
 * Guild settings are read on paths that run far more often than they change:
 * once per Discord message the bot observes, and once per player state change.
 * A single bot process owns this SQLite file, so an in-process cache is
 * authoritative — nothing else can write behind our back. Misses are cached as
 * null too, because unconfigured guilds are the common case for message traffic.
 */
export class GuildSettingsRepository {
  private readonly cache = new Map<string, GuildSettings | null>();

  public async get(guildId: string): Promise<GuildSettings | null> {
    const cached = this.cache.get(guildId);
    if (cached !== undefined) {
      return cached;
    }

    const settings = await prisma.guildSettings.findUnique({ where: { guildId } });
    this.cache.set(guildId, settings);
    return settings;
  }

  public async listWithPlayerChannel(): Promise<GuildSettings[]> {
    const rows = await prisma.guildSettings.findMany({
      where: {
        playerChannelId: {
          not: null
        }
      }
    });

    for (const row of rows) {
      this.cache.set(row.guildId, row);
    }

    return rows;
  }

  public async getOrCreate(guildId: string): Promise<GuildSettings> {
    const cached = this.cache.get(guildId);
    if (cached) {
      return cached;
    }

    const settings = await prisma.guildSettings.upsert({
      where: { guildId },
      create: { guildId },
      update: {}
    });

    this.cache.set(guildId, settings);
    return settings;
  }

  public async upsert(guildId: string, patch: GuildSettingsPatch): Promise<GuildSettings> {
    const settings = await prisma.guildSettings.upsert({
      where: { guildId },
      create: {
        guildId,
        ...patch
      },
      update: patch
    });

    this.cache.set(guildId, settings);
    return settings;
  }

  /** Drops a cached entry. Only needed if the database is modified out of band. */
  public invalidate(guildId: string): void {
    this.cache.delete(guildId);
  }
}

import type { GuildSettings } from '@prisma/client';

import { prisma } from '../prisma.js';

export type GuildSettingsPatch = {
  playerChannelId?: string | null;
  playerMessageId?: string | null;
  djRoleId?: string | null;
};

export class GuildSettingsRepository {
  public async get(guildId: string): Promise<GuildSettings | null> {
    return prisma.guildSettings.findUnique({ where: { guildId } });
  }

  public async listWithPlayerChannel(): Promise<GuildSettings[]> {
    return prisma.guildSettings.findMany({
      where: {
        playerChannelId: {
          not: null
        }
      }
    });
  }

  public async getOrCreate(guildId: string): Promise<GuildSettings> {
    return prisma.guildSettings.upsert({
      where: { guildId },
      create: { guildId },
      update: {}
    });
  }

  public async upsert(guildId: string, patch: GuildSettingsPatch): Promise<GuildSettings> {
    return prisma.guildSettings.upsert({
      where: { guildId },
      create: {
        guildId,
        ...patch
      },
      update: patch
    });
  }
}

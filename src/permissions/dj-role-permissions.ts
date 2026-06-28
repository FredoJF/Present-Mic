import type { GuildMember } from 'discord.js';

export function hasDjRole(member: GuildMember, djRoleId: string | null | undefined): boolean {
  if (!djRoleId) {
    return true;
  }

  return member.roles.cache.has(djRoleId);
}

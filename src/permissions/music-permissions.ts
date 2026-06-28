import { PermissionFlagsBits, type GuildMember } from 'discord.js';

import { hasDjRole } from './dj-role-permissions.js';

export type MusicPermissionContext = {
  member: GuildMember;
  djRoleId?: string | null;
};

export function canControlPlayer({ member, djRoleId }: MusicPermissionContext): boolean {
  const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
  return isAdmin || hasDjRole(member, djRoleId);
}

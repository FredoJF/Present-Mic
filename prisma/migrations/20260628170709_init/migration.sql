-- CreateTable
CREATE TABLE "GuildSettings" (
    "guildId" TEXT NOT NULL PRIMARY KEY,
    "playerChannelId" TEXT,
    "playerMessageId" TEXT,
    "djRoleId" TEXT,
    "cleanupEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

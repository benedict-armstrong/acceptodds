import { randomBytes } from 'node:crypto';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, groupMembers, groups, type Group } from '@/db/schema';
import { ApiError } from './api/errors';

/**
 * Leaderboard groups (#25): a named set of traders, ranked among themselves
 * on the leaderboard (`views.leaderboardStandings({ group })`).
 *
 * The trader who makes a group is its admin and its first member. Anyone
 * joins with the invite code, which every member can see and share; the
 * admin may rename the group, rotate the code (the old link then stops
 * working), remove members and delete it. A member may leave; the admin may
 * not, short of deleting the group.
 *
 * An institution is a group too, but a derived one — every trader with a
 * confirmed affiliation there (`accounts.institutions`) — and never a row
 * here, so it cannot drift from the affiliations.
 *
 * No money and no market state: every write is one statement or one short
 * transaction of its own, never inside a trade. Nothing here moves a
 * balance or a share vector, so the standings cache needs no bump.
 */

/** Groups one account may be the admin of at once. */
export const MAX_GROUPS_PER_ADMIN = 20;

export type GroupRole = 'admin' | 'member';

export interface GroupMember {
  accountId: string;
  handle: string;
  displayName: string;
  isBot: boolean;
  institutions: readonly string[];
  joinedAt: Date;
}

export interface GroupSummary {
  group: Group;
  memberCount: number;
  role: GroupRole;
}

function newInviteCode(): string {
  return randomBytes(12).toString('base64url');
}

export async function groupById(id: string, database: Database = getDb()): Promise<Group | null> {
  const [row] = await database.select().from(groups).where(eq(groups.id, id));
  return row ?? null;
}

export async function groupByInviteCode(code: string, database: Database = getDb()): Promise<Group | null> {
  const [row] = await database.select().from(groups).where(eq(groups.inviteCode, code));
  return row ?? null;
}

/** A group's members, in the order they joined (the admin first). */
export async function groupMembersOf(groupId: string, database: Database = getDb()): Promise<GroupMember[]> {
  const rows = await database
    .select({
      accountId: accounts.id,
      handle: accounts.handle,
      displayName: accounts.displayName,
      isBot: accounts.isBot,
      institutions: accounts.institutions,
      joinedAt: groupMembers.joinedAt,
    })
    .from(groupMembers)
    .innerJoin(accounts, eq(accounts.id, groupMembers.accountId))
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(asc(groupMembers.joinedAt), asc(accounts.id));
  return rows;
}

/** `accountId`'s role in the group, or null when not a member. */
export async function roleIn(
  group: Group,
  accountId: string | null,
  database: Database = getDb(),
): Promise<GroupRole | null> {
  if (accountId === null) return null;
  if (group.adminAccountId === accountId) return 'admin';
  const [row] = await database
    .select({ accountId: groupMembers.accountId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.accountId, accountId)));
  return row ? 'member' : null;
}

/** The groups an account is in, by name, each with its size and the account's role. */
export async function groupsOf(accountId: string, database: Database = getDb()): Promise<GroupSummary[]> {
  const rows = await database
    .select({
      group: groups,
      memberCount: sql<number>`(select count(*)::int from group_members m where m.group_id = ${groups.id})`,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(eq(groupMembers.accountId, accountId))
    .orderBy(asc(sql`lower(${groups.name})`), asc(groups.id));
  return rows.map((r) => ({
    group: r.group,
    memberCount: r.memberCount,
    role: r.group.adminAccountId === accountId ? 'admin' : 'member',
  }));
}

/** Make a group, with `accountId` as its admin and first member. */
export async function createGroup(
  accountId: string,
  input: { name: string; description?: string | null },
  database: Database = getDb(),
): Promise<Group> {
  return database.transaction(async (tx) => {
    // Serializes one admin's creations, so the cap cannot be raced past.
    await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).for('update');
    const [{ n }] = await tx.select({ n: count() }).from(groups).where(eq(groups.adminAccountId, accountId));
    if (n >= MAX_GROUPS_PER_ADMIN) {
      throw new ApiError(409, 'too_many_groups', `you already run ${MAX_GROUPS_PER_ADMIN} groups`);
    }
    const [group] = await tx
      .insert(groups)
      .values({
        name: input.name,
        description: input.description || null,
        adminAccountId: accountId,
        inviteCode: newInviteCode(),
      })
      .returning();
    await tx.insert(groupMembers).values({ groupId: group.id, accountId });
    return group;
  });
}

/** The group, if `accountId` is its admin: 404 when there is none, 403 when someone else runs it. */
async function administered(accountId: string, groupId: string, database: Database): Promise<Group> {
  const group = await groupById(groupId, database);
  if (!group) throw new ApiError(404, 'not_found', `no group ${groupId}`);
  if (group.adminAccountId !== accountId) throw new ApiError(403, 'forbidden', 'only the group’s admin can do that');
  return group;
}

/** Rename the group or change its description (null clears it). Admin only. */
export async function updateGroup(
  accountId: string,
  groupId: string,
  patch: { name?: string; description?: string | null },
  database: Database = getDb(),
): Promise<Group> {
  await administered(accountId, groupId, database);
  const set: Partial<Pick<Group, 'name' | 'description'>> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description || null;
  if (Object.keys(set).length === 0) return (await groupById(groupId, database))!;
  const [group] = await database.update(groups).set(set).where(eq(groups.id, groupId)).returning();
  return group;
}

/** A new invite code; the old link stops working. Admin only. */
export async function rotateInvite(accountId: string, groupId: string, database: Database = getDb()): Promise<Group> {
  await administered(accountId, groupId, database);
  const [group] = await database
    .update(groups)
    .set({ inviteCode: newInviteCode() })
    .where(eq(groups.id, groupId))
    .returning();
  return group;
}

/** Delete the group and every membership. Admin only. */
export async function deleteGroup(accountId: string, groupId: string, database: Database = getDb()): Promise<void> {
  await administered(accountId, groupId, database);
  await database.delete(groups).where(eq(groups.id, groupId));
}

/** Join the group whose invite code this is. Idempotent: a member stays one. 404 for a code that is not current. */
export async function joinGroup(accountId: string, code: string, database: Database = getDb()): Promise<Group> {
  const group = await groupByInviteCode(code, database);
  if (!group) throw new ApiError(404, 'not_found', 'this invite link is not valid, or has been replaced');
  await database.insert(groupMembers).values({ groupId: group.id, accountId }).onConflictDoNothing();
  return group;
}

/**
 * Take `handle` out of the group: yourself (leaving), or anyone if you are
 * the admin. The admin cannot be removed (`409 group_admin`); they delete
 * the group instead. Idempotent for someone who is not a member.
 */
export async function removeMember(
  actorId: string,
  groupId: string,
  handle: string,
  database: Database = getDb(),
): Promise<boolean> {
  const group = await groupById(groupId, database);
  if (!group) throw new ApiError(404, 'not_found', `no group ${groupId}`);
  const [target] = await database.select({ id: accounts.id }).from(accounts).where(eq(accounts.handle, handle));
  if (!target) throw new ApiError(404, 'not_found', `no trader @${handle}`);
  if (target.id !== actorId && group.adminAccountId !== actorId) {
    throw new ApiError(403, 'forbidden', 'only the group’s admin can remove someone else');
  }
  if (target.id === group.adminAccountId) {
    throw new ApiError(409, 'group_admin', 'the admin cannot leave the group; delete it instead');
  }
  const rows = await database
    .delete(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.accountId, target.id)))
    .returning({ accountId: groupMembers.accountId });
  return rows.length > 0;
}

import type { Invitation, Member } from "@telflo/contracts";

/*
 * Members of one group organization, for the Permissions page's tests. The
 * viewer is an admin; the owner is the owner of a personal organization,
 * which only a personal organization lists, but the page treats the flag the
 * same wherever it appears. Every date is at noon UTC, so it falls on the
 * same day in any time zone the tests run in.
 */

export const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000003";

export const VIEWER: Member = {
  userId: "00000000-0000-4000-8000-000000000001",
  email: "viewer@example.com",
  role: "admin",
  isOrganizationOwner: false,
  createdAt: "2026-01-10T12:00:00.000Z",
  deletedAt: null,
};

export const OWNER: Member = {
  userId: "00000000-0000-4000-8000-000000000011",
  email: "owner@example.com",
  role: "admin",
  isOrganizationOwner: true,
  createdAt: "2026-01-05T12:00:00.000Z",
  deletedAt: null,
};

export const CONTRIBUTOR: Member = {
  userId: "00000000-0000-4000-8000-000000000012",
  email: "contributor@example.com",
  role: "contributor",
  isOrganizationOwner: false,
  createdAt: "2026-03-15T12:00:00.000Z",
  deletedAt: null,
};

export const REMOVED: Member = {
  userId: "00000000-0000-4000-8000-000000000013",
  email: "removed@example.com",
  role: "contributor",
  isOrganizationOwner: false,
  createdAt: "2026-02-01T12:00:00.000Z",
  deletedAt: "2026-04-20T12:00:00.000Z",
};

/*
 * Pending invitations to the same organization, newest first as the API
 * lists them. The second is past its expiry, which the API says.
 */

export const INVITED_CONTRIBUTOR: Invitation = {
  id: "00000000-0000-4000-8000-000000000021",
  email: "invited@example.com",
  role: "contributor",
  invitedAt: "2026-05-02T12:00:00.000Z",
  expiresAt: "2026-05-09T12:00:00.000Z",
  isExpired: false,
};

export const EXPIRED_INVITATION: Invitation = {
  id: "00000000-0000-4000-8000-000000000022",
  email: "expired@example.com",
  role: "admin",
  invitedAt: "2026-04-01T12:00:00.000Z",
  expiresAt: "2026-04-08T12:00:00.000Z",
  isExpired: true,
};

/** An en-US date with the time, for a date at noon UTC on `day` ("Mar 15, 2026"). */
export function enUsDateTime(day: string): RegExp {
  return new RegExp(`^${day}, \\d{2}:\\d{2} (AM|PM)$`);
}

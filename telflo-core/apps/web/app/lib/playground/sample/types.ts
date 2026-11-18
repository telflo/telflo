import { DEFAULT_USER_PREFERENCES, type Configuration, type ConfigurationVersion, type ConfigurationVersionSummary } from "@telflo/contracts";
import { ApiError } from "~/lib/api-client.js";
import type { StoredCurrentUser } from "~/lib/stores/user-store.js";
import { SAMPLE_ORGANIZATION_ID } from "~/lib/workspace-reads.js";

/*
 * The sample workspace's shared facts (D31-1 decision 10, Preflight rulings
 * 6 and 7): "Acme Observability", its people, its fixed ids and its times.
 *
 * Every object of the sample is in the platform's shapes, parsed by its
 * contracts schema in sample.test.ts. Ids are fixed, stable, lowercase,
 * v4-shaped literals (never generated, so a link survives the rebuild);
 * dates are `toISOString()` of times relative to now, so "last seen" stays
 * fresh. No secret-shaped value anywhere: emails and hosts on
 * `acme.example`, addresses in RFC 5737's ranges, sha256s as 64 hex
 * digits, nothing shaped like a `tf_`, `tqd_` or `tll_` token or a long
 * base64 run (sample.test.ts checks the whole sample).
 */

export const SAMPLE_ORGANIZATION_NAME = "Acme Observability";

/** The visitor: the sample's "you", who created most of its configurations. */
export const SAMPLE_VISITOR_USER_ID = "00000000-0000-4000-8000-0000000000a1";
export const SAMPLE_VISITOR_EMAIL = "you@acme.example";

/** The sample's other people, named on the configurations they created. */
export const SAMPLE_SRE = { userId: "00000000-0000-4000-8000-0000000000a2", email: "sre@acme.example" } as const;
export const SAMPLE_SECURITY = { userId: "00000000-0000-4000-8000-0000000000a3", email: "security@acme.example" } as const;
export const SAMPLE_VISITOR = { userId: SAMPLE_VISITOR_USER_ID, email: SAMPLE_VISITOR_EMAIL } as const;

/** The pins the sample spreads across: the Contrib versions the platform offers, newest first (Preflight ruling 7). */
export const SAMPLE_PINS = ["0.162.0", "0.161.0", "0.160.0", "0.159.0"] as const;

/** A new or blank configuration's pin, and the public editor's Example's: the newest offered. */
export const NEW_CONFIGURATION_PIN = "0.162.0";

export const SAMPLE_DISTRIBUTION = "otelcol-contrib";

/**
 * The sample's visitor in `/me`'s shape, for `useCurrentUser()` inside the
 * playground: the sample's organization (an admin's, so every action
 * shows, each of them locked), the default preferences with `theme`, the
 * one on screen.
 */
export function sampleVisitor(theme: StoredCurrentUser["preferences"]["theme"] = DEFAULT_USER_PREFERENCES.theme): StoredCurrentUser {
  const organization = { id: SAMPLE_ORGANIZATION_ID, name: SAMPLE_ORGANIZATION_NAME, type: "group", logoId: null, role: "admin" } as const;
  return {
    user: { id: SAMPLE_VISITOR_USER_ID, email: SAMPLE_VISITOR_EMAIL },
    organization,
    organizations: [organization],
    isProductAdmin: false,
    mayCreateOrganizations: true,
    preferences: { ...DEFAULT_USER_PREFERENCES, theme },
  };
}

/** Times relative to `now`, as the API writes them. */
export interface SampleClock {
  /** `ms` before now. */
  ago: (ms: number) => string;
  /** `ms` after now. */
  ahead: (ms: number) => string;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function clockAt(now: number): SampleClock {
  return {
    ago: (ms) => new Date(now - ms).toISOString(),
    ahead: (ms) => new Date(now + ms).toISOString(),
  };
}

/**
 * The sample's answer for an id it doesn't hold: the API's own refusal
 * (its code, status and words), so every page shows its own "not found"
 * (the editor's `EditorUnavailable`, `FleetNotFound`; decision 25).
 */
export function sampleNotFound(code: string, message: string): ApiError {
  return new ApiError(code, message, { status: 404 });
}

/** One sample configuration as the editor's read answers it: the configuration, the version it opens and every version's summary. */
export interface SampleConfiguration {
  configuration: Configuration;
  /** The version it opens: always a draft (D11b's lock would make a published one read-only; Ruling 276). */
  version: ConfigurationVersion;
  /** Every version, highest number first; a published configuration's older published version among them. */
  versions: ConfigurationVersionSummary[];
}

import { describe, expect, it } from "vitest";
import { parseUserAgent, USER_AGENT_PARSED_LENGTH } from "./user-agent.js";

/*
 * The sessions list's families (D21 decision 40, Preflight ruling 17), over
 * real user agents: at least one per family and per system, Playwright's
 * three browsers, a bot, nothing at all and a very long string.
 */

const MAC = "Macintosh; Intel Mac OS X 10_15_7";
const WINDOWS = "Windows NT 10.0; Win64; x64";
const LINUX = "X11; Linux x86_64";
const WEBKIT = "AppleWebKit/537.36 (KHTML, like Gecko)";

const chrome = (platform: string) => `Mozilla/5.0 (${platform}) ${WEBKIT} Chrome/131.0.0.0 Safari/537.36`;
const firefox = (platform: string) => `Mozilla/5.0 (${platform}; rv:133.0) Gecko/20100101 Firefox/133.0`;

const cases: Array<[label: string, userAgent: string | null, browser: string, os: string]> = [
  // Current desktop browsers on macOS, Windows and Linux.
  ["Firefox on macOS", firefox(MAC), "firefox", "macos"],
  ["Firefox on Windows", firefox(WINDOWS), "firefox", "windows"],
  ["Firefox on Linux", firefox(LINUX), "firefox", "linux"],
  ["Chrome on macOS", chrome(MAC), "chrome", "macos"],
  ["Chrome on Windows", chrome(WINDOWS), "chrome", "windows"],
  ["Chrome on Linux", chrome(LINUX), "chrome", "linux"],
  ["Edge on macOS", `${chrome(MAC)} Edg/131.0.0.0`, "edge", "macos"],
  ["Edge on Windows", `${chrome(WINDOWS)} Edg/131.0.0.0`, "edge", "windows"],
  ["Edge on Linux", `${chrome(LINUX)} Edg/131.0.0.0`, "edge", "linux"],
  [
    "legacy Edge (EdgeHTML) on Windows",
    `Mozilla/5.0 (${WINDOWS}) ${WEBKIT} Chrome/70.0.3538.102 Safari/537.36 Edge/18.19582`,
    "edge",
    "windows",
  ],
  ["Opera on macOS", `${chrome(MAC)} OPR/115.0.0.0`, "opera", "macos"],
  ["Opera on Windows", `${chrome(WINDOWS)} OPR/115.0.0.0`, "opera", "windows"],
  ["Opera on Linux", `${chrome(LINUX)} OPR/115.0.0.0`, "opera", "linux"],
  [
    "Safari on macOS",
    `Mozilla/5.0 (${MAC}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15`,
    "safari",
    "macos",
  ],
  // Mobile.
  [
    "Safari on iPhone",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    "safari",
    "ios",
  ],
  [
    // An `iPad;` string, as iPadOS 12 sent and an iPad asking for the mobile site still does (ruling 17).
    "Safari on iPad",
    "Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1",
    "safari",
    "ios",
  ],
  [
    "Chrome on iOS",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
    "chrome",
    "ios",
  ],
  [
    "Firefox on iOS",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15",
    "firefox",
    "ios",
  ],
  [
    "Opera Touch on iOS",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 OPT/5.3.0 Mobile/15E148 Safari/604.1",
    "opera",
    "ios",
  ],
  [
    "Opera Mini on iOS",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) OPiOS/16.0.14.122053 Mobile/15E148 Safari/9537.53",
    "opera",
    "ios",
  ],
  [
    "Edge on iOS",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/131.2903.68 Mobile/15E148 Safari/605.1.15",
    "edge",
    "ios",
  ],
  [
    "Chrome on Android",
    `Mozilla/5.0 (Linux; Android 10; K) ${WEBKIT} Chrome/131.0.0.0 Mobile Safari/537.36`,
    "chrome",
    "android",
  ],
  [
    "Edge on Android",
    `Mozilla/5.0 (Linux; Android 10; K) ${WEBKIT} Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.0.0`,
    "edge",
    "android",
  ],
  [
    "Samsung Internet on Android",
    `Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) ${WEBKIT} SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36`,
    "other",
    "android",
  ],
  [
    "Chrome on ChromeOS",
    `Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) ${WEBKIT} Chrome/131.0.0.0 Safari/537.36`,
    "chrome",
    "chromeos",
  ],
  // Playwright's three desktop descriptors read the same whatever the host (ruling 17).
  [
    "Playwright's Desktop Chrome",
    `Mozilla/5.0 (${WINDOWS}) ${WEBKIT} Chrome/153.0.8010.12 Safari/537.36`,
    "chrome",
    "windows",
  ],
  [
    "Playwright's Desktop Firefox",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0",
    "firefox",
    "windows",
  ],
  [
    "Playwright's Desktop Safari",
    `Mozilla/5.0 (${MAC}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15`,
    "safari",
    "macos",
  ],
  // Synthetic strings pinning the rules' order: the first family listed wins.
  ["both Edg/ and OPR/: Edge comes first", `${chrome(WINDOWS)} OPR/115.0.0.0 Edg/131.0.0.0`, "edge", "windows"],
  [
    "both OPR/ and SamsungBrowser/: Opera comes first",
    `${chrome(LINUX)} SamsungBrowser/27.0 OPR/115.0.0.0`,
    "opera",
    "linux",
  ],
  ["both SamsungBrowser/ and Chrome/: other comes first", `${chrome(LINUX)} SamsungBrowser/27.0`, "other", "linux"],
  // Neither a browser nor a system we name.
  ["a bot", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "other", "other"],
  ["curl", "curl/8.7.1", "other", "other"],
  ["light-my-request's default (server.inject)", "lightMyRequest", "other", "other"],
  ["Safari/ without Version/", `Mozilla/5.0 (${MAC}) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15`, "other", "macos"],
  ["an empty string", "", "other", "other"],
  ["null: no user agent recorded", null, "other", "other"],
];

describe("parseUserAgent (D21 decision 40)", () => {
  it.each(cases)("%s", (_label, userAgent, browser, os) => {
    expect(parseUserAgent(userAgent)).toEqual({ browser, os });
  });

  it("reads only the first 512 characters of 10,000: a token past them counts for nothing", () => {
    const padding = "x".repeat(USER_AGENT_PARSED_LENGTH);
    expect(parseUserAgent(`${padding}${firefox(WINDOWS)}`.padEnd(10_000, "y"))).toEqual({
      browser: "other",
      os: "other",
    });
    expect(parseUserAgent(firefox(WINDOWS).padEnd(10_000, "y"))).toEqual({ browser: "firefox", os: "windows" });
  });

  it("parses 10,000 strings of 10,000 characters without backtracking: plain substring tests only", () => {
    const long = `Mozilla/5.0 (${"(".repeat(5_000)}${" ".repeat(4_900)}`;
    let parsed = 0;
    for (let round = 0; round < 10_000; round += 1) {
      if (parseUserAgent(long).browser === "other") parsed += 1;
    }
    expect(parsed).toBe(10_000);
  });
});

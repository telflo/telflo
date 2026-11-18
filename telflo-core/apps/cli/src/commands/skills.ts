/*
 * `telflo skills install [--project | --global]` (D27 decision 29): copies the `telflo-cli` agent skill
 * the package ships (`skills/telflo-cli/`, beside `dist/`) into
 * `./.claude/skills/` (the default) or `~/.claude/skills/`.
 *
 * It writes only under the folder it names. A previous copy is removed
 * first (so a file the skill no longer ships doesn't linger), and that
 * removal is limited to `<root>/telflo-cli` itself: a link there (even a
 * dangling one) or a file is unlinked, never followed; only a real folder
 * is removed with what it holds.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { emit, EXIT, ExitError } from "../output.js";

/** The skill's folder name, in the package and where it is installed. */
export const SKILL_NAME = "telflo-cli";

export const PROJECT_AND_GLOBAL_MESSAGE = "Give at most one of --project and --global.";
export const SKILL_MISSING_MESSAGE = "This copy of the CLI holds no skill to install (its skills folder is missing).";
export const CANNOT_INSTALL_MESSAGE = (path: string): string => `Can't install the skill into ${path}.`;

/** `skills/telflo-cli`, beside `dist/` in the package (package.json's `files`): from `dist/commands/` or `src/commands/`, two folders up. */
export function skillsSourceDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", SKILL_NAME);
}

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    count += statSync(path).isDirectory() ? countFiles(path) : 1;
  }
  return count;
}

/**
 * The folder the skill is installed into, `<root>/telflo-cli`: the only
 * path ever removed. (Its name is always the skill's and its parent the
 * root: `SKILL_NAME` holds no separator and no `..`.)
 */
export function skillTarget(root: string): string {
  return join(resolve(root), SKILL_NAME);
}

/**
 * Removes what is at `path`, never following a link (Ruling 249): a link
 * (a dangling one too: `existsSync` and `rmSync`'s `force` see none) or a
 * file is unlinked; only a real folder is removed with what it holds.
 */
export function removeEarlierCopy(path: string): void {
  let entry: Stats;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entry.isDirectory()) rmSync(path, { recursive: true });
  else unlinkSync(path);
}

/** Copies the skill into `<root>/telflo-cli`, replacing an earlier copy: the folder installed and how many files it holds. */
export function installSkills(root: string, source: string = skillsSourceDir()): { installed: string; files: number } {
  if (!existsSync(join(source, "SKILL.md"))) throw new ExitError(SKILL_MISSING_MESSAGE, EXIT.API);
  const target = skillTarget(root);
  try {
    mkdirSync(dirname(target), { recursive: true });
    removeEarlierCopy(target);
    cpSync(source, target, { recursive: true });
  } catch {
    throw new ExitError(CANNOT_INSTALL_MESSAGE(target), EXIT.API);
  }
  return { installed: target, files: countFiles(target) };
}

export interface SkillsInstallOptions {
  project?: boolean;
  global?: boolean;
}

/** Where a run's two roots are: the working folder and the home folder (a test's own). */
export interface SkillsPlaces {
  cwd: string;
  home: string;
}

/** `telflo skills install`: `./.claude/skills` by default, `~/.claude/skills` with `--global`. */
export function skillsInstall(options: SkillsInstallOptions, places: SkillsPlaces = { cwd: process.cwd(), home: homedir() }): void {
  if (options.project === true && options.global === true) throw new ExitError(PROJECT_AND_GLOBAL_MESSAGE, EXIT.USAGE);
  const root = join(options.global === true ? places.home : places.cwd, ".claude", "skills");
  const result = installSkills(root);
  emit(result, () => `Installed the ${SKILL_NAME} skill (${result.files} files) in ${result.installed}.`);
}

export function registerSkillsCommands(program: Command): void {
  const skills = program.command("skills").description("The agent skill for AI coding assistants that use this CLI");
  skills
    .command("install")
    .description("Install the telflo-cli skill into ./.claude/skills (--project, the default) or ~/.claude/skills (--global)")
    .option("--project", "install into ./.claude/skills (the default)")
    .option("--global", "install into ~/.claude/skills")
    .action((options: SkillsInstallOptions) => skillsInstall(options));
}

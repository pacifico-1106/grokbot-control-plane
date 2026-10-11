import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

export type DependencyMap = Record<string, string>;
type JsonObject = Record<string, unknown>;
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
const FIX_COMMAND = "corepack pnpm@10 install --lockfile-only";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dependencySections(value: JsonObject): DependencyMap {
  const dependencies: DependencyMap = {};
  for (const section of DEPENDENCY_SECTIONS) {
    const entries = value[section];
    if (!isObject(entries)) continue;
    for (const [name, specifier] of Object.entries(entries)) {
      if (typeof specifier === "string") dependencies[name] = specifier;
    }
  }
  return dependencies;
}

function stripJsonComments(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    const next = text[index + 1];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      output += "\n";
    } else if (character === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] === "\n") output += "\n";
        index++;
      }
      index++;
    } else {
      output += character;
    }
  }
  return output;
}

function removeTrailingCommas(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === ",") {
      let lookahead = index + 1;
      while (/\s/.test(text[lookahead] ?? "")) lookahead++;
      if (text[lookahead] !== "]" && text[lookahead] !== "}") output += character;
    } else {
      output += character;
    }
  }
  return output;
}

function parseJsonLike(text: string): JsonObject {
  const parsed: unknown = JSON.parse(removeTrailingCommas(stripJsonComments(text)));
  if (!isObject(parsed)) throw new Error("lockfile root must be an object");
  return parsed;
}

export function parsePackageJson(text: string): DependencyMap {
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) throw new Error("package.json root must be an object");
  return dependencySections(parsed);
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed) as string;
  return trimmed;
}

function parseYamlKey(value: string): string {
  return parseYamlScalar(value.replace(/\s+$/, ""));
}

export function parsePnpmLock(text: string): DependencyMap {
  const dependencies: DependencyMap = {};
  let inImporters = false;
  let inRootImporter = false;
  let section: (typeof DEPENDENCY_SECTIONS)[number] | undefined;
  let dependencyName: string | undefined;

  for (const line of text.split(/\r?\n/)) {
    if (/^importers:\s*$/.test(line)) {
      inImporters = true;
      continue;
    }
    if (!inImporters) continue;
    if (/^  \.:\s*$/.test(line)) {
      inRootImporter = true;
      section = undefined;
      dependencyName = undefined;
      continue;
    }
    if (!inRootImporter) continue;
    if (line.trim() && line.match(/^\S/)) break;

    const sectionMatch = line.match(/^    (dependencies|devDependencies|optionalDependencies):\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1] as (typeof DEPENDENCY_SECTIONS)[number];
      dependencyName = undefined;
      continue;
    }
    if (!section) continue;

    const entryMatch = line.match(/^      (.+):\s*$/);
    if (entryMatch) {
      dependencyName = parseYamlKey(entryMatch[1]);
      continue;
    }
    const specifierMatch = line.match(/^        specifier:\s*(.+?)\s*$/);
    if (specifierMatch && dependencyName) dependencies[dependencyName] = parseYamlScalar(specifierMatch[1]);
  }
  return dependencies;
}

export function parsePackageLock(text: string): DependencyMap {
  const parsed = parseJsonLike(text);
  const packages = isObject(parsed.packages) ? parsed.packages : {};
  const rootPackage = isObject(packages[""]) ? packages[""] : {};
  return dependencySections(rootPackage);
}

export function parseBunLock(text: string): DependencyMap {
  const parsed = parseJsonLike(text);
  const workspaces = isObject(parsed.workspaces) ? parsed.workspaces : {};
  const rootWorkspace = isObject(workspaces[""]) ? workspaces[""] : {};
  return dependencySections(rootWorkspace);
}

export function compareLockfiles(
  packageJson: string,
  locks: { pnpm: string; npm: string; bun: string },
): string[] {
  const expected = parsePackageJson(packageJson);
  const parsedLocks: Array<[string, DependencyMap]> = [
    ["pnpm-lock.yaml", parsePnpmLock(locks.pnpm)],
    ["package-lock.json", parsePackageLock(locks.npm)],
    ["bun.lock", parseBunLock(locks.bun)],
  ];
  const errors: string[] = [];
  for (const [name, specifier] of Object.entries(expected).sort(([left], [right]) => left.localeCompare(right))) {
    for (const [lockfile, dependencies] of parsedLocks) {
      if (!(name in dependencies)) {
        errors.push(`${lockfile}: dependency "${name}" is missing (expected specifier "${specifier}"). Fix with: ${FIX_COMMAND}`);
      } else if (dependencies[name] !== specifier) {
        errors.push(`${lockfile}: dependency "${name}" has specifier "${dependencies[name]}" but package.json requires "${specifier}". Fix with: ${FIX_COMMAND}`);
      }
    }
  }
  return errors;
}

const packageJsonFixture = JSON.stringify({
  dependencies: { "@scope/pkg": "~1.2.3", undici: "^6.29.0" },
  devDependencies: { typescript: "^5" },
  optionalDependencies: { fsevents: "^2" },
});
const pnpmFixture = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@scope/pkg':
        specifier: ~1.2.3
        version: 1.2.3
      undici:
        specifier: ^6.29.0
        version: 6.29.0
    devDependencies:
      typescript:
        specifier: ^5
        version: 5.0.0
    optionalDependencies:
      fsevents:
        specifier: ^2
        version: 2.3.3
`;
const npmFixture = JSON.stringify({
  packages: {
    "": {
      dependencies: { "@scope/pkg": "~1.2.3", undici: "^6.29.0" },
      devDependencies: { typescript: "^5" },
      optionalDependencies: { fsevents: "^2" },
    },
  },
});
const bunFixture = `{
  "workspaces": {
    "": {
      "dependencies": { "@scope/pkg": "~1.2.3", "undici": "^6.29.0", },
      "devDependencies": { "typescript": "^5", },
      "optionalDependencies": { "fsevents": "^2", },
    },
  },
}`;

test("parses dependency specifiers from all three lockfile formats", () => {
  expect(parsePnpmLock(pnpmFixture)).toEqual({ "@scope/pkg": "~1.2.3", undici: "^6.29.0", typescript: "^5", fsevents: "^2" });
  expect(parsePackageLock(npmFixture)).toEqual(parsePackageJson(packageJsonFixture));
  expect(parseBunLock(bunFixture)).toEqual(parsePackageJson(packageJsonFixture));
});

test("regression #272: package.json with undici fails when pnpm lock omits it", () => {
  const pnpmWithoutUndici = pnpmFixture.replace(/      undici:[\s\S]*?        version: 6\.29\.0\n/, "");
  const errors = compareLockfiles(packageJsonFixture, {
    pnpm: pnpmWithoutUndici,
    npm: npmFixture,
    bun: bunFixture,
  });
  expect(errors.join("\n")).toContain('pnpm-lock.yaml: dependency "undici" is missing');
  expect(errors.every((error) => error.includes(FIX_COMMAND))).toBe(true);
});

test("real package and lockfiles are synchronized", () => {
  const errors = compareLockfiles(readFileSync("package.json", "utf8"), {
    pnpm: readFileSync("pnpm-lock.yaml", "utf8"),
    npm: readFileSync("package-lock.json", "utf8"),
    bun: readFileSync("bun.lock", "utf8"),
  });
  expect(errors).toEqual([]);
});

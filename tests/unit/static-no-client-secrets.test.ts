// Static scans (no app code executed):
//  1. Client modules ("use client" files and what they import) must not reach server code:
//     no imports of "@/server/**", "server-only", or any local module that (transitively) imports
//     "server-only"; no process.env reads other than NEXT_PUBLIC_* (and NODE_ENV, which Next inlines).
//  2. No file in src (or .env.example) names a NEXT_PUBLIC_ variable that looks like a secret or the
//     service-role key. NEXT_PUBLIC_ values are inlined into browser bundles.
//  3. Fixture files contain no real-looking Indian mobile numbers, and no emails/URLs outside
//     example.com / example.org.
// Client modules = files whose first statement is "use client", plus every local module they import.
// Lives in tests/unit because vitest.config.mts includes only src/** and tests/unit/**.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SRC = path.join(ROOT, "src");
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? (name === "node_modules" ? [] : walk(p)) : [p];
  });
}
const rel = (p: string) => path.relative(ROOT, p);
const read = (p: string) => readFileSync(p, "utf8");
const srcFiles = walk(SRC).filter((f) => CODE_EXT.test(f));

/** Strip comments so documentation that *mentions* a pattern does not trip the scan. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** True when the module's first statement is the "use client" directive. */
function isClientModule(code: string): boolean {
  return /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/.test(code);
}

/** True when the module's first statement is "use server" (a Server Actions module). */
function isServerActionModule(code: string): boolean {
  return /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use server["']/.test(code);
}

const IMPORT_RE =
  /(?:import|export)\s+(type\s+)?(?:[^;"'`]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

/** Every import/export/require specifier, including type-only ones. */
function importSpecifiers(code: string): string[] {
  return [...stripComments(code).matchAll(IMPORT_RE)].map((m) => m[2] ?? m[3] ?? m[4]);
}

/** Specifiers that survive compilation (`import type` / `export type` are erased). */
function runtimeImports(code: string): string[] {
  return [...stripComments(code).matchAll(IMPORT_RE)].filter((m) => !m[1]).map((m) => m[2] ?? m[3] ?? m[4]);
}

/** process.env reads that are not NEXT_PUBLIC_* or NODE_ENV (including dynamic access). */
function forbiddenEnvReads(code: string): string[] {
  const c = stripComments(code);
  const bad: string[] = [];
  for (const m of c.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\s*\[\s*(["'`]?)([^\]"'`]*)\2\s*\]|\b(?!\s*[.[]))/g)) {
    const name = m[1] ?? (m[2] ? m[3] : null);
    if (name && (name.startsWith("NEXT_PUBLIC_") || name === "NODE_ENV")) continue;
    bad.push(name ?? m[0].trim());
  }
  return bad;
}

const SECRET_PUBLIC = /NEXT_PUBLIC_[A-Z0-9_]*(SERVICE|SECRET|PRIVATE|PASSWORD|ROLE|TOKEN)[A-Z0-9_]*/g;
const PUBLIC_KEY = /NEXT_PUBLIC_[A-Z0-9_]*KEY\b/g;
const ALLOWED_PUBLIC_KEYS = /^NEXT_PUBLIC_[A-Z0-9_]*(ANON_KEY|PUBLISHABLE_KEY)$/;
function secretPublicNames(code: string): string[] {
  const hits = [...code.matchAll(SECRET_PUBLIC)].map((m) => m[0]);
  for (const m of code.matchAll(PUBLIC_KEY)) if (!ALLOWED_PUBLIC_KEYS.test(m[0])) hits.push(m[0]);
  return [...new Set(hits)];
}

function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const cand of [base, ...[".ts", ".tsx", ".js", ".jsx"].map((e) => base + e), ...["index.ts", "index.tsx"].map((i) => path.join(base, i))]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

const isServerPath = (file: string) => rel(file).split(path.sep).slice(0, 2).join("/") === "src/server";
const importsServerOnly = (code: string) => runtimeImports(code).includes("server-only");

/**
 * Next.js client-boundary rules: a client module may import a "use server" module (it becomes a
 * Server Action reference, not bundled code) and may `import type` anything. Any other runtime
 * import of src/server/**, "server-only", or a module that imports "server-only" is a leak.
 */
type Edge = { spec: string; file: string | null; serverAction: boolean };
function runtimeEdges(file: string): Edge[] {
  return runtimeImports(read(file)).map((spec) => {
    const target = resolveLocal(file, spec);
    return { spec, file: target, serverAction: !!target && isServerActionModule(read(target)) };
  });
}

/** Walks local imports from a client module; returns the chain to the first server-only module. */
function serverReachableChain(entry: string): string[] | null {
  const seen = new Set<string>();
  const stack: { file: string; chain: string[] }[] = [{ file: entry, chain: [rel(entry)] }];
  while (stack.length) {
    const { file, chain } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = read(file);
    // A nested "use client" module is its own client boundary and is scanned separately.
    if (file !== entry && isClientModule(code)) continue;
    if (file !== entry && (isServerPath(file) || importsServerOnly(code))) return chain;
    for (const e of runtimeEdges(file)) {
      if (e.serverAction) continue;
      if (e.spec === "server-only" || e.spec.startsWith("@/server") || (e.file && isServerPath(e.file)))
        return [...chain, e.spec];
      if (e.file && CODE_EXT.test(e.file)) stack.push({ file: e.file, chain: [...chain, rel(e.file)] });
    }
  }
  return null;
}

// Entry points of the client bundle. Shared modules (e.g. src/components/**) that a client module
// imports are reached through the import walk below; server components in src/components that are
// never imported from a client module may legitimately use server code.
const clientFiles = srcFiles.filter((f) => isClientModule(read(f)));

/** All local modules bundled for the browser: client entries plus everything they import. */
function clientReachable(): string[] {
  const out = new Set<string>();
  const stack = [...clientFiles];
  while (stack.length) {
    const f = stack.pop()!;
    if (out.has(f)) continue;
    out.add(f);
    for (const e of runtimeEdges(f)) if (e.file && !e.serverAction && CODE_EXT.test(e.file)) stack.push(e.file);
  }
  return [...out];
}

describe("scanner self-checks", () => {
  it("detects client directives, server imports, env reads and secret public names", () => {
    expect(isClientModule('"use client";\nimport x from "y";')).toBe(true);
    expect(isClientModule("// header\n'use client'\n")).toBe(true);
    expect(isClientModule('import "x";\n"use client";')).toBe(false);
    expect(importSpecifiers('import { a } from "@/server/auth";\nimport "server-only";\nconst m = await import("./x");')).toEqual([
      "@/server/auth",
      "server-only",
      "./x",
    ]);
    expect(importSpecifiers('import type {\n  A,\n  B,\n} from "@/server/repositories";')).toEqual(["@/server/repositories"]);
    expect(runtimeImports('import type { A } from "@/server/actions/types";\nimport { b } from "./b";')).toEqual(["./b"]);
    expect(isServerActionModule('"use server";\nimport "server-only";')).toBe(true);
    expect(isServerActionModule('import "server-only";')).toBe(false);
    expect(forbiddenEnvReads("const a = process.env.NEXT_PUBLIC_SITE_URL; const b = process.env.NODE_ENV;")).toEqual([]);
    expect(forbiddenEnvReads("const k = process.env.SUPABASE_SERVICE_ROLE_KEY;")).toEqual(["SUPABASE_SERVICE_ROLE_KEY"]);
    expect(forbiddenEnvReads('const k = process.env["SESSION_SECRET"];')).toEqual(["SESSION_SECRET"]);
    expect(forbiddenEnvReads("const { X } = process.env;")).toHaveLength(1);
    expect(forbiddenEnvReads("// process.env.SECRET in a comment")).toEqual([]);
    expect(secretPublicNames("NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_API_KEY")).toEqual([
      "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
      "NEXT_PUBLIC_API_KEY",
    ]);
  });

  it("finds the source tree", () => {
    expect(srcFiles.length).toBeGreaterThan(10);
    // Every module under src/server that reads secrets is server-only.
    for (const f of ["src/server/env.ts", "src/server/auth.ts", "src/server/repositories/supabase/client.ts"]) {
      expect(importsServerOnly(read(path.join(ROOT, f))), f).toBe(true);
    }
    // The import walk reaches server code from a module that imports it.
    expect(serverReachableChain(path.join(SRC, "server/services/search.ts"))).not.toBeNull();
    expect(serverReachableChain(path.join(SRC, "leads/validation.ts"))).toBeNull();
  });
});

describe("client modules cannot reach server code or secrets", () => {
  it(`no client module imports server code (scanned ${clientFiles.length} client files)`, () => {
    const violations = clientFiles
      .map((f) => ({ f: rel(f), chain: serverReachableChain(f) }))
      .filter((v) => v.chain)
      .map((v) => `${v.f}: ${v.chain!.join(" -> ")}`);
    expect(violations).toEqual([]);
  });

  it("no client module reads non-public environment variables", () => {
    const violations = clientReachable().flatMap((f) => forbiddenEnvReads(read(f)).map((n) => `${rel(f)}: process.env ${n}`));
    expect(violations).toEqual([]);
  });

  it("no file in src or .env.example names a secret-looking NEXT_PUBLIC_ variable", () => {
    const files = [...srcFiles, path.join(ROOT, ".env.example")].filter((f) => existsSync(f));
    const violations = files.flatMap((f) => secretPublicNames(read(f)).map((n) => `${rel(f)}: ${n}`));
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fixture PII / fabricated contact scan
// ---------------------------------------------------------------------------
const fixtureFiles = walk(SRC).filter((f) => {
  const r = rel(f).split(path.sep).join("/");
  return CODE_EXT.test(f) && (/\/fixtures?[^/]*$/.test(r) || /\/fixtures?\//.test(r) || /sample-projects\.ts$/.test(r));
});

const PHONE_PATTERNS = [
  /(?<![\d.])(?:\+91[\s-]?|0091[\s-]?|\b0)?[6-9]\d{9}(?![\d.])/g, // 9876543210, +919876543210
  /(?<![\d.])(?:\+91[\s-]?)?[6-9]\d{4}[\s-]\d{5}(?![\d.])/g, // 98765 43210, +91-98765-43210
  /(?<![\d.])(?:\+91[\s-]?)?[6-9]\d{2}[\s-]\d{3}[\s-]\d{4}(?![\d.])/g, // 987-654-3210
];
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const URL_RE = /https?:\/\/([^/\s"'`)]+)/g;
const SAFE_DOMAIN = /(^|\.)example\.(com|org)$/i;

function findPhones(code: string): string[] {
  return PHONE_PATTERNS.flatMap((re) => [...code.matchAll(re)].map((m) => m[0]));
}
function findUnsafeEmails(code: string): string[] {
  return [...code.matchAll(EMAIL)].filter((m) => !SAFE_DOMAIN.test(m[1])).map((m) => m[0]);
}
function findUnsafeUrls(code: string): string[] {
  return [...code.matchAll(URL_RE)].filter((m) => !SAFE_DOMAIN.test(m[1].replace(/:\d+$/, ""))).map((m) => m[0]);
}

describe("fixtures contain no real-looking personal data or real URLs", () => {
  it("scanner self-check", () => {
    expect(findPhones("call 9876543210 or +91 98765 43210 or 987-654-3210")).toHaveLength(3);
    expect(findPhones("lat: 13.0358, lng: 77.597, price 15000000, 2026-10-01T00:00:00.000Z")).toEqual([]);
    expect(findUnsafeEmails("a@example.com b@mail.example.org c@gmail.com")).toEqual(["c@gmail.com"]);
    expect(findUnsafeUrls("https://example.com/x https://www.example.org/ https://rera.karnataka.gov.in/")).toEqual([
      "https://rera.karnataka.gov.in",
    ]);
  });

  it(`finds the fixture files`, () => {
    const names = fixtureFiles.map(rel).map((r) => r.split(path.sep).join("/"));
    expect(names).toContain("src/server/repositories/fixture/sample-projects.ts");
    expect(names).toContain("src/discovery/fixtures.ts");
  });

  it("no fixture file contains an Indian mobile number, a non-example email or a non-example URL", () => {
    const violations = fixtureFiles.flatMap((f) => {
      const code = read(f);
      return [
        ...findPhones(code).map((x) => `${rel(f)}: phone-like "${x}"`),
        ...findUnsafeEmails(code).map((x) => `${rel(f)}: email "${x}"`),
        ...findUnsafeUrls(code).map((x) => `${rel(f)}: url "${x}"`),
      ];
    });
    expect(violations).toEqual([]);
  });
});

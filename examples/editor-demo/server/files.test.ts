import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_DIRECTORY, updateDemoFiles, type DemoChange } from "./files.js";

const workspaces: string[] = [];
function workspace() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "paseo-editor-demo-test-")));
  workspaces.push(directory);
  return directory;
}
function observer() {
  return {
    assertActive: vi.fn<() => void>(),
    started: vi.fn<(change: DemoChange) => void>(),
    completed: vi.fn<(change: DemoChange) => void>(),
    failed: vi.fn<(change: DemoChange, error: unknown) => void>(),
  };
}

afterEach(() => {
  for (const directory of workspaces.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Editor demo real files", () => {
  it("creates readable source, edits coherently, and recognizes files without session state", () => {
    const cwd = workspace();
    const firstObserver = observer();
    const created = updateDemoFiles(cwd, "auto", firstObserver);
    expect(created).toMatchObject({ changes: 2, revision: 1 });
    expect(created.files.map((file) => readFileSync(file, "utf8"))).toEqual([
      expect.stringContaining("Hello, ${name}! Welcome to Paseo."),
      expect.stringContaining('const visitors = ["Ada", "Grace"]'),
    ]);
    for (const [change] of firstObserver.completed.mock.calls) {
      expect(readFileSync(change.filePath, "utf8")).toBe(change.after);
      expect(change.before).toBeNull();
    }
    expect(updateDemoFiles(cwd, "create", observer())).toMatchObject({ changes: 0, revision: 1 });
    const edited = updateDemoFiles(cwd, "edit", observer());
    expect(edited).toMatchObject({ changes: 2, revision: 2 });
    expect(readFileSync(edited.files[0]!, "utf8")).toContain('name.trim() || "friend"');
    expect(readFileSync(edited.files[1]!, "utf8")).toContain("visitors.map(greet)");
    expect(updateDemoFiles(cwd, "auto", observer())).toMatchObject({ changes: 2, revision: 3 });
    expect(readFileSync(edited.files[0]!, "utf8")).toContain("revision 3");
  });

  it("rejects manual edits before changing either file and preserves unrelated content", () => {
    const cwd = workspace();
    const initial = updateDemoFiles(cwd, "create", observer());
    const originalGreeting = readFileSync(initial.files[0]!, "utf8");
    const manuallyEdited = readFileSync(initial.files[1]!, "utf8") + "// my notes\n";
    writeFileSync(initial.files[1]!, manuallyEdited);
    const unrelated = join(cwd, DEMO_DIRECTORY, "personal.txt");
    writeFileSync(unrelated, "keep me");
    const callbacks = observer();
    expect(() => updateDemoFiles(cwd, "edit", callbacks)).toThrow(
      "unrecognized content or manual edits",
    );
    expect(callbacks.started).not.toHaveBeenCalled();
    expect(readFileSync(initial.files[0]!, "utf8")).toBe(originalGreeting);
    expect(readFileSync(initial.files[1]!, "utf8")).toBe(manuallyEdited);
    expect(readFileSync(unrelated, "utf8")).toBe("keep me");
  });

  it("refuses preexisting unrecognized files rather than claiming ownership", () => {
    const cwd = workspace();
    mkdirSync(join(cwd, DEMO_DIRECTORY));
    const file = join(cwd, DEMO_DIRECTORY, "greeting.ts");
    writeFileSync(file, "export const mine = true;\n");
    expect(() => updateDemoFiles(cwd, "create", observer())).toThrow("unrecognized content");
    expect(readFileSync(file, "utf8")).toBe("export const mine = true;\n");
  });

  it("rejects symlink directories and files without modifying their targets", () => {
    const cwd = workspace();
    const outside = workspace();
    symlinkSync(outside, join(cwd, DEMO_DIRECTORY), "dir");
    expect(() => updateDemoFiles(cwd, "create", observer())).toThrow(
      "symlink or changed demo directory",
    );
    rmSync(join(cwd, DEMO_DIRECTORY));
    mkdirSync(join(cwd, DEMO_DIRECTORY));
    const target = join(outside, "private.ts");
    writeFileSync(target, "private data");
    symlinkSync(target, join(cwd, DEMO_DIRECTORY, "greeting.ts"));
    expect(() => updateDemoFiles(cwd, "edit", observer())).toThrow("regular file");
    expect(readFileSync(target, "utf8")).toBe("private data");
    const alias = join(outside, "workspace-alias");
    symlinkSync(cwd, alias, "dir");
    expect(() => updateDemoFiles(alias, "create", observer())).toThrow("symlink workspace");
  });

  it("refuses hard links even when their content looks owned", () => {
    const cwd = workspace();
    const created = updateDemoFiles(cwd, "create", observer());
    const content = readFileSync(created.files[0]!, "utf8");
    linkSync(created.files[0]!, join(cwd, "linked.ts"));
    expect(() => updateDemoFiles(cwd, "edit", observer())).toThrow("hard links");
    expect(readFileSync(join(cwd, "linked.ts"), "utf8")).toBe(content);
  });

  it("detects a file changed after preflight and reports the actual failed tool", () => {
    const cwd = workspace();
    const created = updateDemoFiles(cwd, "create", observer());
    const callbacks = observer();
    callbacks.started.mockImplementation((change: DemoChange) => {
      writeFileSync(change.filePath, "changed after preflight\n");
    });
    expect(() => updateDemoFiles(cwd, "edit", callbacks)).toThrow(
      "manually changed before writing",
    );
    expect(callbacks.completed).not.toHaveBeenCalled();
    expect(callbacks.failed).toHaveBeenCalledOnce();
    expect(readFileSync(created.files[0]!, "utf8")).toBe("changed after preflight\n");
  });
});

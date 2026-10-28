import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";

export const DEMO_DIRECTORY = "paseo-editor-demo";
const FILE_NAMES = ["greeting.ts", "main.ts"] as const;
type DemoFileName = (typeof FILE_NAMES)[number];

export interface DemoChange {
  filePath: string;
  before: string | null;
  after: string;
}

export interface DemoResult {
  files: string[];
  changes: number;
  revision: number;
}

function renderFile(name: DemoFileName, revision: number): string {
  const header = `// Paseo editor-demo v1; revision ${revision}; managed file, do not edit.\n`;
  if (name === "greeting.ts") {
    return (
      header +
      (revision % 2 === 1
        ? `export function greet(name: string): string {\n  return \`Hello, \${name}! Welcome to Paseo.\`;\n}\n`
        : `export function greet(name: string): string {\n  const recipient = name.trim() || "friend";\n  return \`Welcome back, \${recipient}! Your editor is ready.\`;\n}\n`)
    );
  }
  return (
    header +
    `import { greet } from "./greeting.js";\n\n` +
    (revision % 2 === 1
      ? `const visitors = ["Ada", "Grace"];\nfor (const visitor of visitors) {\n  console.log(greet(visitor));\n}\n`
      : `const visitors = ["Ada", "Grace", "Linus"];\nconst messages = visitors.map(greet);\nconsole.log(messages.join("\\n"));\n`)
  );
}

function assertRegularFile(filePath: string, stat: Stats): void {
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Refusing ${filePath}: expected a regular file with no hard links or symlinks`);
  }
  if (stat.size > 64 * 1024)
    throw new Error(`Refusing ${filePath}: demo files must be smaller than 64 KiB`);
}

function inspectFile(
  filePath: string,
  name: DemoFileName,
): { text: string; revision: number } | null {
  let stat: Stats;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  assertRegularFile(filePath, stat);
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    assertRegularFile(filePath, opened);
    if (stat.dev !== opened.dev || stat.ino !== opened.ino) {
      throw new Error(`Refusing ${filePath}: the file changed while being inspected`);
    }
    const text = readFileSync(fd, "utf8");
    const match =
      /^\/\/ Paseo editor-demo v1; revision ([1-9][0-9]*); managed file, do not edit\.\n/u.exec(
        text,
      );
    const revision = Number(match?.[1]);
    if (!Number.isSafeInteger(revision) || revision < 1 || text !== renderFile(name, revision)) {
      throw new Error(
        `Refusing ${filePath}: unrecognized content or manual edits; move the file aside to preserve it before repeating the demo`,
      );
    }
    return { text, revision };
  } finally {
    closeSync(fd);
  }
}

function writeCheckedFile(change: DemoChange, assertDirectory: () => void): void {
  assertDirectory();
  const flags =
    constants.O_NOFOLLOW |
    (change.before !== null
      ? constants.O_RDWR
      : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  const fd = openSync(change.filePath, flags, 0o644);
  try {
    const stat = fstatSync(fd);
    assertRegularFile(change.filePath, stat);
    assertDirectory();
    const current = lstatSync(change.filePath);
    if (current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev) {
      throw new Error(`Refusing ${change.filePath}: file changed before writing`);
    }
    if (change.before !== null && readFileSync(fd, "utf8") !== change.before) {
      throw new Error(`Refusing ${change.filePath}: file was manually changed before writing`);
    }
    // An explicit position is needed because reading an existing descriptor advances its offset.
    const bytes = Buffer.from(change.after);
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written, written);
      if (count === 0) throw new Error(`Unable to finish writing ${change.filePath}`);
      written += count;
    }
    ftruncateSync(fd, bytes.length);
  } finally {
    closeSync(fd);
  }
}

// Synchronous, small writes keep each checked mutation indivisible to other plugin turns.
// The caller yields for cancellation before entering this section; no prompt is executed as code.
export function updateDemoFiles(
  cwd: string,
  action: "create" | "edit" | "auto",
  observer: {
    assertActive(): void;
    started(change: DemoChange): void;
    completed(change: DemoChange): void;
    failed(change: DemoChange, error: unknown): void;
  },
): DemoResult {
  observer.assertActive();
  const workspace = resolve(cwd);
  if (lstatSync(workspace).isSymbolicLink())
    throw new Error(`Refusing symlink workspace: ${workspace}`);
  const root = realpathSync(workspace);
  if (!lstatSync(root).isDirectory()) throw new Error(`Workspace is not a directory: ${root}`);
  const directory = join(root, DEMO_DIRECTORY);
  try {
    mkdirSync(directory);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const directoryStat = lstatSync(directory);
  const assertDirectory = () => {
    const current = lstatSync(directory);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      realpathSync(directory) !== directory ||
      current.ino !== directoryStat.ino ||
      current.dev !== directoryStat.dev
    ) {
      throw new Error(`Refusing symlink or changed demo directory: ${directory}`);
    }
  };
  assertDirectory();
  const existing = FILE_NAMES.map((name) => inspectFile(join(directory, name), name));
  const hasFiles = existing.some((file) => file !== null);
  const shouldEdit = action === "edit" || (action === "auto" && hasFiles);
  const previousRevision = Math.max(0, ...existing.map((file) => file?.revision ?? 0));
  const revision = shouldEdit ? previousRevision + 1 : Math.max(1, previousRevision);
  if (!Number.isSafeInteger(revision))
    throw new Error("Demo revision limit reached; move the demo directory aside to start again");
  let changes = 0;
  for (const [index, name] of FILE_NAMES.entries()) {
    observer.assertActive();
    const previous = existing[index];
    if (previous && !shouldEdit) continue;
    const change: DemoChange = {
      filePath: join(directory, name),
      before: previous?.text ?? null,
      after: renderFile(name, revision),
    };
    observer.started(change);
    try {
      observer.assertActive();
      writeCheckedFile(change, assertDirectory);
      changes += 1;
      observer.completed(change);
    } catch (error) {
      observer.failed(change, error);
      throw error;
    }
  }
  return { files: FILE_NAMES.map((name) => join(directory, name)), changes, revision };
}

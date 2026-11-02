import fs from "node:fs";
import path from "node:path";

// A workspace dependency can be installed locally when npm cannot hoist it.
// Preserve both levels of module resolution in the isolated native build.
export function linkNativeStageDependencies(root, stage) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  if (!Array.isArray(manifest.workspaces)) {
    throw new Error(
      "Native staging requires an explicit workspace directory list.",
    );
  }
  for (const workspace of [".", ...manifest.workspaces]) {
    if (typeof workspace !== "string" || /[*?{}]/.test(workspace)) {
      throw new Error(
        "Native staging requires explicit workspace directories, without patterns.",
      );
    }
    const relative = path.relative(
      path.resolve(root),
      path.resolve(root, workspace),
    );
    if (
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new Error(
        "Native staging workspace must be inside the repository.",
      );
    }
    const source = path.join(root, relative, "node_modules");
    if (!fs.existsSync(source)) {
      if (!relative)
        throw new Error("Install root dependencies before native packaging.");
      continue;
    }
    const destination = path.join(stage, relative, "node_modules");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(
      path.resolve(source),
      destination,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
}

import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { durableWrite } from "./managed/storage.js";

export async function prepareAssets(source: string, cache: string) {
  const [script, style, template] = await Promise.all(
    ["app.js", "styles.css", "index.html"].map((name) =>
      readFile(join(source, name), "utf8"),
    ),
  );
  const revision = createHash("sha256")
    .update(script!)
    .update(style!)
    .update(template!)
    .digest("hex")
    .slice(0, 16);
  const directory = join(cache, revision);
  await mkdir(directory, { recursive: true });
  for (const [name, content] of [
    ["app.js", script!],
    ["styles.css", style!],
  ]) {
    const target = join(directory, name!);
    const existing = await readFile(target, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (existing !== content) await durableWrite(target, content!);
  }
  return {
    revision,
    html: template!.replace(
      /(["'])\/(app\.js|styles\.css)\1/g,
      `$1/assets/${revision}/$2$1`,
    ),
  };
}

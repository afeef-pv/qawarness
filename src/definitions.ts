import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { loadScenario, parseScenario } from "./core/scenario";

export interface DefinitionInput {
  name: string;
  description?: string;
  startUrl?: string;
  instruction?: string;
  proof?: string;
}

async function latestVersion(directory: string): Promise<number> {
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return files.reduce((version, file) => {
    const match = /^v([1-9]\d*)\.yaml$/.exec(file);
    const found = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(found) ? Math.max(version, found) : version;
  }, 0);
}

export async function definitionPath(name: string): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new Error("Invalid definition name");
  const directory = join("scenarios", name);
  const version = await latestVersion(directory);
  if (!version) throw new Error(`No definition named ${name}`);
  return join(directory, `v${version}.yaml`);
}

export async function defineScenario(input: DefinitionInput): Promise<{ path: string; version: number }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.name)) {
    throw new Error("Definition name must use letters, numbers, underscores, or hyphens");
  }
  const directory = join("scenarios", input.name);
  const latest = await latestVersion(directory);
  const current = latest ? await loadScenario(join(directory, `v${latest}.yaml`)) : undefined;
  if (current && current.name !== input.name) throw new Error(`Definition ${input.name} has a mismatched latest version`);
  if (!current && (!input.description?.trim() || !input.startUrl?.trim() || !input.instruction?.trim() || !input.proof?.trim())) {
    throw new Error("A new definition needs --description, --start-url, --instruction, and --proof");
  }
  for (const [name, value] of Object.entries(input)) {
    if (name !== "name" && value !== undefined && !value.trim()) throw new Error(`--${name === "startUrl" ? "start-url" : name} must be nonempty`);
  }
  const scenario = parseScenario({
    name: input.name,
    description: input.description ?? current?.description,
    startUrl: input.startUrl ?? current?.startUrl,
    instruction: input.instruction ?? current?.instruction,
    proof: input.proof === undefined ? current?.proof : [{ type: "judge", text: input.proof }],
    maxSteps: current?.maxSteps ?? 30,
    ...(current?.maxDuration ? { maxDuration: current.maxDuration } : {}),
  });
  if (current && JSON.stringify(scenario) === JSON.stringify(current)) throw new Error(`Definition ${input.name} is unchanged`);
  const version = latest + 1;
  const path = join(directory, `v${version}.yaml`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, YAML.stringify({ fileType: "qawarness/test/v1", ...scenario }, { lineWidth: 0 }), { flag: "wx" });
  return { path, version };
}

export function harnessRevision(): string {
  const revision = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  if (revision.exitCode !== 0) return "unknown";
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { stdout: "pipe", stderr: "ignore" });
  const value = new TextDecoder().decode(revision.stdout).trim();
  return `${value}${status.exitCode === 0 && status.stdout.length ? "-dirty" : ""}`;
}

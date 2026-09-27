import { mkdir } from "node:fs/promises";

import { PlaywrightEnvironment } from "./environments/playwright";

async function main(): Promise<void> {
  const runDirectory = "runs/smoke";

  await mkdir(runDirectory, {
    recursive: true,
  });

  const environment = new PlaywrightEnvironment();

  try {
    console.log("Starting environment...");
    await environment.start();

    console.log("Navigating...");
    await environment.navigate("https://example.com");

    console.log("Taking screenshot...");
    await environment.screenshot(`${runDirectory}/page.png`);

    console.log("Observing...");
    const observation = await environment.observe();

    console.dir(observation, {
      depth: null,
    });
  } finally {
    console.log("Closing environment...");
    await environment.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
import path from "path";
import puppeteer from "puppeteer";

// launch browser
export const BROWSER = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  userDataDir: path.join(process.cwd(), "data", "browser"),
  args: ["--no-startup-window"],
  waitForInitialPage: false,
});

for (const event of [
  "SIGINT",
  "SIGUSR1",
  "SIGUSR2",
  "uncaughtException",
  "SIGTERM",
]) {
  process.on(event, async () => {
    await BROWSER.close();
  });
}

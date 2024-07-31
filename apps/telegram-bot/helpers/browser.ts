import fs from "fs";
import os from "os";
import path from "path";
import puppeteer from "puppeteer";

const isProd = process.env.NODE_ENV === "production";

// launch browser
export const BROWSER = await puppeteer.launch({
  headless: isProd,
  defaultViewport: null,
  ignoreHTTPSErrors: true,
  waitForInitialPage: false,
  userDataDir: isProd
    ? await fs.promises.mkdtemp(path.join(os.tmpdir(), "browser-"))
    : path.join(process.cwd(), "browser"),
  ...(isProd
    ? {
        executablePath: "/usr/bin/google-chrome",
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      }
    : {
        args: ["--no-startup-window"],
      }),
});

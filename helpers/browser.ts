import { BROWSER_FILES_DIR } from "@/bot/constants.js";
import fs from "fs";
import isWsl from "is-wsl";
import os from "os";
import path from "path";
import puppeteer from "puppeteer";

const isProd = process.env.NODE_ENV === "production";

// launch browser
export const BROWSER = await puppeteer.launch({
  headless: isProd || isWsl,
  defaultViewport: null,
  waitForInitialPage: false,
  userDataDir: isProd
    ? await fs.promises.mkdtemp(path.join(os.tmpdir(), "browser-"))
    : BROWSER_FILES_DIR,
  ...(isProd
    ? {
        executablePath: "/usr/bin/google-chrome",
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      }
    : {
        args: ["--no-startup-window"],
      }),
});

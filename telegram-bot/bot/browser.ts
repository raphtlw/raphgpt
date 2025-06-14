import puppeteer from "puppeteer-core";

export async function getBrowser() {
  return await puppeteer.connect({
    browserWSEndpoint: "ws://browserless:3000",
    acceptInsecureCerts: true,
    defaultViewport: null,
  });
}

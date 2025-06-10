import puppeteer from "puppeteer-core";

export const browser = await puppeteer.connect({
  browserWSEndpoint: "ws://browserless:3000",
  acceptInsecureCerts: true,
  defaultViewport: null,
});

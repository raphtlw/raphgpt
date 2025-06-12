import { browser } from "bot/browser";
import { $ } from "bun";
import fs from "fs";
import pako from "pako";
import path from "path";
import sharp from "sharp";

interface LottieAnimationData {
  fr: number;
  ip: number;
  op: number;
  [key: string]: any;
}

class TGS {
  private tgsFilePath: string;
  private jsonFilePath: string;
  private framesDir: string;

  constructor(tgsFilePath: string) {
    this.tgsFilePath = tgsFilePath;
    this.jsonFilePath = path.resolve(__dirname, "sticker.json");
    this.framesDir = path.resolve(__dirname, "frames");
    process.on("exit", () => {
      this.cleanup();
    });
  }

  private async cleanup(): Promise<void> {
    try {
      if (fs.existsSync(this.jsonFilePath)) {
        fs.unlinkSync(this.jsonFilePath);
        console.log(`Deleted ${this.jsonFilePath}`);
      }
      if (fs.existsSync(this.framesDir)) {
        fs.rmdirSync(this.framesDir, { recursive: true });
        console.log(`Deleted ${this.framesDir}`);
      }
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  }

  async convertToGif(gifFilePath: string): Promise<string> {
    try {
      const conversionSuccess = await this.convertTgsToJson();
      if (!conversionSuccess) {
        throw new Error("Conversion from TGS to JSON failed.");
      }
      const renderingSuccess = await this.renderJsonToImages();
      if (!renderingSuccess) {
        throw new Error("Rendering JSON to images failed.");
      }
      await this.imagesToGif(gifFilePath);
      return gifFilePath;
    } catch (error) {
      throw error;
    }
  }

  async convertToWebp(webpFilePath: string): Promise<string> {
    try {
      const gifFilePath = path.resolve(__dirname, "sticker.gif");
      await this.convertToGif(gifFilePath);
      await this.convertGifToWebP(gifFilePath, webpFilePath);
      return webpFilePath;
    } catch (error) {
      throw error;
    }
  }

  async convertToMp4(mp4FilePath: string): Promise<string> {
    try {
      const gifFilePath = path.resolve(__dirname, "sticker.gif");
      await this.convertToGif(gifFilePath);
      await this.convertGifToMp4(gifFilePath, mp4FilePath);
      return mp4FilePath;
    } catch (error) {
      throw error;
    }
  }

  private async convertTgsToJson(): Promise<boolean> {
    try {
      const rawBuffer = fs.readFileSync(this.tgsFilePath);
      const decompressedData = pako.inflate(new Uint8Array(rawBuffer), {
        to: "string",
      });
      const animationData: LottieAnimationData = JSON.parse(decompressedData);

      if (typeof animationData !== "object" || animationData === null) {
        throw new Error(
          "Invalid JSON format: Animation data is not an object.",
        );
      }

      fs.writeFileSync(
        this.jsonFilePath,
        JSON.stringify(animationData, null, 2),
      );
      console.log("TGS converted to JSON successfully.");
      return true;
    } catch (error) {
      throw error;
    }
  }

  private async renderJsonToImages(): Promise<boolean> {
    try {
      const animationData: LottieAnimationData = JSON.parse(
        fs.readFileSync(this.jsonFilePath, "utf8"),
      );
      const width = 512;
      const height = 512;

      if (!fs.existsSync(this.framesDir)) {
        fs.mkdirSync(this.framesDir);
      }

      const page = await browser.newPage();
      await page.setViewport({ width, height });

      const htmlContent = `
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Lottie Animation</title>
                </head>
                <body>
                    <div id="animationContainer" style="width: ${width}px; height: ${height}px;"></div>
                    <script src="https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.7.8/lottie_light.min.js"></script>
                    <script>
                        window.animationData = ${JSON.stringify(animationData)};
                        window.animation = null;
                        document.addEventListener('DOMContentLoaded', () => {
                            window.animation = lottie.loadAnimation({
                                container: document.getElementById('animationContainer'),
                                renderer: 'svg',
                                loop: false,
                                autoplay: false,
                                animationData: window.animationData,
                            });
                        });
                    </script>
                </body>
                </html>
            `;

      await page.setContent(htmlContent, { waitUntil: "load" });

      const totalFrames = animationData.op - animationData.ip;
      const frameDuration = 1000 / animationData.fr;

      function delay(time: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, time));
      }

      await page.waitForFunction("window.animation !== null", {
        timeout: 5000,
      });

      for (let i = 0; i < totalFrames; i++) {
        await page.evaluate((frameIdx: number) => {
          const animation = (window as any).animation;
          if (animation) {
            animation.goToAndStop(frameIdx, true);
          }
        }, i);

        const framePath = path.join(this.framesDir, `frame_${i}.png`);
        await page.screenshot({ path: framePath as any });
        await delay(frameDuration);
      }

      console.log("JSON rendered to images successfully.");
      await browser.close();
      return true;
    } catch (error) {
      throw error;
    }
  }

  private async imagesToGif(gifFilePath: string): Promise<boolean> {
    try {
      await $`ffmpeg -framerate 30 -i ${path.join(
        this.framesDir,
        "frame_%d.png",
      )} -vf scale=512:-1 ${gifFilePath}`;

      console.log("Frames compiled to GIF successfully.");
      return true;
    } catch (error) {
      throw error;
    }
  }

  private async convertGifToWebP(
    inputPath: string,
    outputPath: string,
  ): Promise<boolean> {
    try {
      await sharp(inputPath)
        .webp({ quality: 80, effort: 4 })
        .toFile(outputPath);
      console.log("GIF converted to WebP successfully!");
      return true;
    } catch (error) {
      throw error;
    }
  }

  private async convertGifToMp4(
    inputGif: string,
    outputMp4: string,
  ): Promise<boolean> {
    try {
      const command = `ffmpeg -i ${inputGif} ${outputMp4}`;
      console.log("Spawned FFmpeg with command:", command);
      await $`ffmpeg -i ${inputGif} ${outputMp4}`;
      console.log("Conversion completed successfully!");
      return true;
    } catch (error) {
      throw error;
    }
  }
}

export default TGS;

declare module "tgs-to" {
  export default class TGS {
    constructor(filePath: string);

    convertToGif(outputPath: string): Promise<void>;
    convertToWebp(outputPath: string): Promise<void>;
    convertToMp4(outputPath: string): Promise<void>;
  }
}

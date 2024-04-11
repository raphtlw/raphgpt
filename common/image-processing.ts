import sharp from "sharp";

export const calculateDetailAmounts = async (images: string[]) => {
  const laplacianVariances: { imagePath: string; variance: number }[] = [];

  for (const imagePath of images) {
    const laplacianKernel = {
      width: 3,
      height: 3,
      kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
    };

    const laplacianImageData = await sharp(imagePath)
      .greyscale()
      .raw()
      .convolve(laplacianKernel)
      .toBuffer();

    // Calculate the variance of our convolved image
    const mean =
      laplacianImageData.reduce((sum, value) => sum + value, 0) /
      laplacianImageData.length;
    const variance =
      laplacianImageData.reduce(
        (sum, value) => sum + Math.pow(value - mean, 2),
        0,
      ) / laplacianImageData.length;

    laplacianVariances.push({ imagePath, variance });
  }

  laplacianVariances.sort((a, b) => a.variance - b.variance);

  return laplacianVariances;
};

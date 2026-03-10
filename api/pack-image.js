const sharp = require('sharp');

const PADDING = 20;
const BACKGROUND_COLOR = { r: 54, g: 57, b: 63, alpha: 1 };
const TARGET_HEIGHT = 1024;

async function createPlaceholderImage(isSpecial = false) {
  const width = Math.round(TARGET_HEIGHT * 0.7);
  const color = isSpecial
    ? { r: 0, g: 0, b: 0, alpha: 1 }
    : { r: 85, g: 85, b: 85, alpha: 1 };

  return sharp({
    create: { width, height: TARGET_HEIGHT, channels: 4, background: color }
  }).png().toBuffer();
}

async function processCardImage(imageUrl, isSpecial = false) {
  try {
    if (!imageUrl) return createPlaceholderImage(isSpecial);

    const response = await fetch(imageUrl);
    if (!response.ok) {
      console.warn(`Failed to fetch image from ${imageUrl}: ${response.status}`);
      return createPlaceholderImage(isSpecial);
    }

    const imageBuffer = Buffer.from(await response.arrayBuffer());
    let image = sharp(imageBuffer).resize({
      height: TARGET_HEIGHT,
      fit: 'contain',
      kernel: sharp.kernel.lanczos3,
      fastShrinkOnLoad: false
    });

    if (isSpecial) {
      image = image.negate();
    }

    return image.png({ compressionLevel: 6 }).toBuffer();
  } catch (error) {
    console.error(`Error processing image ${imageUrl}:`, error);
    return createPlaceholderImage(isSpecial);
  }
}

module.exports = async function handler(req, res) {
  try {
    // Parse query parameters
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cardUrls = url.searchParams.getAll('url');
    const specialsParam = url.searchParams.get('specials');
    const specialIndices = specialsParam
      ? specialsParam.split(',').map(Number).filter(n => !isNaN(n))
      : [];

    if (cardUrls.length === 0) {
      res.status(400).json({ error: 'No card URLs provided. Use ?url=... query parameters.' });
      return;
    }

    // Process all cards in parallel
    const cardImages = await Promise.all(
      cardUrls.map((cardUrl, i) =>
        processCardImage(cardUrl, specialIndices.includes(i))
      )
    );

    // Get dimensions of each processed card
    const cardDimensions = await Promise.all(
      cardImages.map(buffer => sharp(buffer).metadata())
    );

    // Calculate canvas size
    const totalWidth = cardDimensions.reduce((sum, d) => sum + d.width, 0)
      + (cardDimensions.length - 1) * PADDING
      + PADDING * 2;
    const maxHeight = Math.max(...cardDimensions.map(d => d.height))
      + PADDING * 2;

    // Composite all cards onto background
    const compositeOps = cardImages.map((buffer, i) => ({
      input: buffer,
      left: PADDING + (i === 0 ? 0 :
        cardDimensions.slice(0, i).reduce((sum, d) => sum + d.width + PADDING, 0)),
      top: PADDING
    }));

    const resultBuffer = await sharp({
      create: {
        width: totalWidth,
        height: maxHeight,
        channels: 4,
        background: BACKGROUND_COLOR
      }
    })
      .composite(compositeOps)
      .png({ compressionLevel: 6 })
      .toBuffer();

    // Return the image
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(200).send(resultBuffer);
  } catch (error) {
    console.error('Pack image generation failed:', error);
    res.status(500).json({ error: 'Image generation failed' });
  }
};

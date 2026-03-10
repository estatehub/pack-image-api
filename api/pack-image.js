const sharp = require('sharp');

const PADDING = 20;
const BACKGROUND_COLOR = { r: 54, g: 57, b: 63, alpha: 1 };
const TARGET_HEIGHT = 1024;
const FETCH_TIMEOUT = 15000; // 15 seconds per image

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function fetchImageBuffer(url) {
  // Try up to 2 times
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetchWithTimeout(url, FETCH_TIMEOUT);
      if (!response.ok) {
        console.warn(`Fetch attempt ${attempt} failed for ${url}: HTTP ${response.status}`);
        if (attempt === 2) return null;
        continue;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      console.warn(`Fetch attempt ${attempt} error for ${url}: ${error.message}`);
      if (attempt === 2) return null;
    }
  }
  return null;
}

async function createPlaceholderImage() {
  const width = Math.round(TARGET_HEIGHT * 0.7);
  return sharp({
    create: { width, height: TARGET_HEIGHT, channels: 4, background: { r: 85, g: 85, b: 85, alpha: 1 } }
  }).png().toBuffer();
}

async function processCardImage(imageUrl, isSpecial = false) {
  try {
    if (!imageUrl) return createPlaceholderImage();

    const imageBuffer = await fetchImageBuffer(imageUrl);
    if (!imageBuffer) {
      console.warn(`All fetch attempts failed for ${imageUrl}, using placeholder`);
      return createPlaceholderImage();
    }

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
    return createPlaceholderImage();
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

    console.log(`Processing ${cardUrls.length} cards, specials: [${specialIndices.join(',')}]`);

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

    console.log(`Image generated: ${totalWidth}x${maxHeight}, ${resultBuffer.length} bytes`);

    // Return the image
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(200).send(resultBuffer);
  } catch (error) {
    console.error('Pack image generation failed:', error);
    res.status(500).json({ error: 'Image generation failed' });
  }
};

/** Physical sizing uses document dimensions, never the preview's CSS pixels. */
export function facsimileWidthFromMm(widthMm: number, pageWidthMm: number): number {
  if (!Number.isFinite(widthMm) || widthMm <= 0 || !Number.isFinite(pageWidthMm) || pageWidthMm <= 0) {
    throw new Error("Укажите положительный размер в миллиметрах.");
  }
  return Math.min(0.6, Math.max(0.08, widthMm / pageWidthMm));
}

export function suggestedFacsimileWidthMm(imageAspect: number): number {
  return imageAspect >= 1.6 ? 60 : 40;
}

export function imageDimensions(url: string): Promise<[number, number]> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
    image.onerror = () => reject(new Error("Не удалось прочитать изображение факсимиле."));
    image.src = url;
  });
}

/**
 * Image service - handles capture, metadata extraction, and storage
 *
 * SINGLE SOURCE OF TRUTH:
 * This module creates FrameGeo objects that capture all geometry info at capture time.
 * All subsequent operations should use the FrameGeo instead of re-reading dimensions.
 */

import { Image } from 'react-native';
import RNFS from 'react-native-fs';
import type { PhotoFile } from 'react-native-vision-camera';
import type { ImageMeta } from '../types';
import {
  normalizeFileUri,
  uriToPath,
  getDisplayDimensions,
} from '../utils/frameGeo';

/**
 * Extract EXIF orientation value (1-8)
 * Orientation values:
 * 1: Normal (0 degrees)
 * 2: Flipped horizontal
 * 3: Rotated 180 degrees
 * 4: Flipped vertical
 * 5: Rotated 90 CCW and flipped horizontal
 * 6: Rotated 90 CW
 * 7: Rotated 90 CW and flipped horizontal
 * 8: Rotated 90 CCW
 */
function getOrientationFromMetadata(metadata: any): number {
  // iOS stores EXIF under '{Exif}' key
  const exifKey = '{Exif}';
  if (metadata?.[exifKey]?.Orientation) {
    return metadata[exifKey].Orientation;
  }
  if (metadata?.Orientation) {
    return metadata.Orientation;
  }
  return 1; // Default: normal orientation
}

/**
 * Build ImageMeta from captured photo
 * Uses normalized URI and EXIF-corrected dimensions
 */
export async function buildImageMeta(photo: PhotoFile): Promise<ImageMeta> {
  // NORMALIZE URI - single format everywhere
  const normalizedUri = normalizeFileUri(photo.path);
  const filePath = uriToPath(normalizedUri);

  // Get file stats using clean path
  const stats = await RNFS.stat(filePath);
  const fileSize = typeof stats.size === 'string' ? parseInt(stats.size, 10) : stats.size;

  // Extract orientation from metadata if available
  const orientation = photo.metadata
    ? getOrientationFromMetadata(photo.metadata)
    : 1;

  // Get EXIF-corrected dimensions (this is the DISPLAY size)
  const rawWidth = photo.width;
  const rawHeight = photo.height;
  const { pixelW, pixelH } = getDisplayDimensions(rawWidth, rawHeight, orientation);

  // For now, we mark as not normalized - actual normalization would require
  // image processing which we handle in preprocessing
  const isNormalized = orientation === 1;

  console.log(`[ImageService] buildImageMeta: raw=${rawWidth}x${rawHeight}, EXIF=${orientation}, display=${pixelW}x${pixelH}`);

  return {
    uri: normalizedUri,
    width: pixelW,
    height: pixelH,
    fileSize,
    timestamp: Date.now(),
    orientation,
    isNormalized,
  };
}

/**
 * Build ImageMeta from a fixture or existing image file
 */
export async function buildImageMetaFromUri(uri: string): Promise<ImageMeta> {
  const cleanPath = uri.startsWith('file://') ? uri.slice(7) : uri;
  const fileUri = uri.startsWith('file://') ? uri : `file://${uri}`;

  // Get file stats
  const stats = await RNFS.stat(cleanPath);
  const fileSize = typeof stats.size === 'string' ? parseInt(stats.size, 10) : stats.size;

  // Get image dimensions
  return new Promise((resolve, reject) => {
    Image.getSize(
      fileUri,
      (width, height) => {
        resolve({
          uri: fileUri,
          width,
          height,
          fileSize,
          timestamp: Date.now(),
          orientation: 1, // Fixtures are assumed to be correctly oriented
          isNormalized: true,
        });
      },
      (error) => {
        reject(new Error(`Failed to get image size: ${error}`));
      }
    );
  });
}

/**
 * Get app's private images directory
 */
export function getPrivateImagesDir(): string {
  return `${RNFS.DocumentDirectoryPath}/images`;
}

/**
 * Ensure private images directory exists
 */
export async function ensurePrivateImagesDir(): Promise<string> {
  const dir = getPrivateImagesDir();
  const exists = await RNFS.exists(dir);
  if (!exists) {
    await RNFS.mkdir(dir);
  }
  return dir;
}

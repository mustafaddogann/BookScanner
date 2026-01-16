/**
 * Image service - handles capture, metadata extraction, and storage
 *
 * SINGLE SOURCE OF TRUTH:
 * This module creates FrameGeo objects that capture all geometry info at capture time.
 * All subsequent operations should use the FrameGeo instead of re-reading dimensions.
 */

import { Platform, Image } from 'react-native';
import RNFS from 'react-native-fs';
import type { PhotoFile } from 'react-native-vision-camera';
import type { ImageMeta, ScanSession } from '../types';
import { generateSessionId, createSessionDir, copyOriginalImage } from './debugArtifacts';
import { useAppStore, storage } from '../store/useAppStore';
import {
  type FrameGeo,
  normalizeFileUri,
  uriToPath,
  buildFrameGeo,
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
 * Get corrected dimensions based on EXIF orientation
 */
function getCorrectedDimensions(
  width: number,
  height: number,
  orientation: number
): { width: number; height: number } {
  // Orientations 5, 6, 7, 8 involve 90-degree rotations
  if (orientation >= 5 && orientation <= 8) {
    return { width: height, height: width };
  }
  return { width, height };
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
 * Build FrameGeo from captured photo - SINGLE SOURCE OF TRUTH
 *
 * This creates the geometry object that should be used for ALL coordinate
 * mapping in the session. Do not re-read image dimensions after this.
 */
export function buildFrameGeoFromPhoto(photo: PhotoFile, modelSize: number = 640): FrameGeo {
  const orientation = photo.metadata
    ? getOrientationFromMetadata(photo.metadata)
    : 1;

  return buildFrameGeo(
    photo.path,
    photo.width,
    photo.height,
    orientation,
    modelSize
  );
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
 * Create a new scan session from a captured photo
 */
export async function createSessionFromCapture(
  photo: PhotoFile
): Promise<{ session: ScanSession; imageMeta: ImageMeta }> {
  const sessionId = generateSessionId();

  console.log(`[ImageService] Creating session ${sessionId} from capture`);

  // Create session directory
  const sessionDir = await createSessionDir(sessionId);

  // Build image metadata
  const imageMeta = await buildImageMeta(photo);

  // Copy original image to session directory
  const imagePath = await copyOriginalImage(sessionId, photo.path);

  // Create session object
  const session: ScanSession = {
    sessionId,
    createdAt: new Date().toISOString(),
    source: 'camera',
    imagePath,
    sessionDir,
    detectionCount: 0,
    status: 'pending',
  };

  // Store session
  useAppStore.getState().addSession(session);

  console.log(`[ImageService] Session created: ${sessionId}`);
  return { session, imageMeta };
}

/**
 * Create a new scan session from a fixture
 */
export async function createSessionFromFixture(
  fixtureUri: string,
  fixtureName: string
): Promise<{ session: ScanSession; imageMeta: ImageMeta }> {
  const sessionId = generateSessionId();

  console.log(`[ImageService] Creating session ${sessionId} from fixture: ${fixtureName}`);

  // Create session directory
  const sessionDir = await createSessionDir(sessionId);

  // Build image metadata
  const imageMeta = await buildImageMetaFromUri(fixtureUri);

  // Copy fixture image to session directory
  const imagePath = await copyOriginalImage(sessionId, fixtureUri);

  // Create session object
  const session: ScanSession = {
    sessionId,
    createdAt: new Date().toISOString(),
    source: 'fixture',
    fixtureName,
    imagePath,
    sessionDir,
    detectionCount: 0,
    status: 'pending',
  };

  // Store session
  useAppStore.getState().addSession(session);

  console.log(`[ImageService] Session created: ${sessionId}`);
  return { session, imageMeta };
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

/**
 * Copy a captured photo to private storage
 */
export async function copyToPrivateStorage(sourcePath: string): Promise<string> {
  const imagesDir = await ensurePrivateImagesDir();
  const filename = `capture_${Date.now()}.jpg`;
  const destPath = `${imagesDir}/${filename}`;

  const cleanSource = sourcePath.startsWith('file://') ? sourcePath.slice(7) : sourcePath;
  await RNFS.copyFile(cleanSource, destPath);

  console.log(`[ImageService] Copied to private storage: ${destPath}`);
  return destPath;
}

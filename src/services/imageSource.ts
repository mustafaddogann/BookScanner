/**
 * ImageSource Abstraction - Unified interface for different image sources
 *
 * Provides a common interface for:
 * - CameraSource: Live camera captures
 * - FixtureSource: Bundled/device test images
 * - ReplaySource: Replay from saved sessions (uses cached tensor)
 *
 * This abstraction enables:
 * - Consistent pipeline interface regardless of image origin
 * - Replay capability for deterministic testing
 * - Easy addition of new source types
 */

import RNFS from 'react-native-fs';
import type {
  ImageSourceType,
  ImageSourceMetadata,
  CameraSourceMetadata,
  FixtureSourceMetadata,
  ReplaySourceMetadata,
  LetterboxParams,
  SavedTensor,
  FixtureInfo,
} from '../types';
import { normalizeFileUri } from '../utils/frameGeo';
import { buildImageMetaFromUri } from './imageService';
import { getSessionDir } from './debugArtifacts';

/**
 * Abstract ImageSource interface
 * All image sources must implement this interface
 */
export interface ImageSource {
  /** Get source type discriminator */
  getType(): ImageSourceType;

  /** Get normalized image URI for display/processing */
  getImageUri(): string;

  /** Get full metadata for this source */
  getMetadata(): Promise<ImageSourceMetadata>;

  /** Check if this source can be replayed (has saved tensor) */
  canReplay(): boolean;

  /** Get preprocessed tensor if available (for replay sources) */
  getPreprocessedTensor(): Promise<Float32Array | null>;

  /** Get saved letterbox params if available (for replay sources) */
  getSavedLetterbox(): LetterboxParams | null;

  /** Get saved native truth if available (for replay sources) */
  getSavedNativeTruth(): SavedTensor['nativeTruth'] | null;
}

// ============================================================================
// Base64 Decode Helper
// ============================================================================

/**
 * Decode base64 string to Uint8Array
 * (atob may not be available in React Native)
 */
function base64Decode(base64: string): Uint8Array {
  const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let i = 0; i < base64Chars.length; i++) {
    lookup[base64Chars.charCodeAt(i)] = i;
  }

  // Remove padding
  let len = base64.length;
  if (base64[len - 1] === '=') len--;
  if (base64[len - 1] === '=') len--;

  const bytes = new Uint8Array(Math.floor(len * 3 / 4));
  let p = 0;

  for (let i = 0; i < len; i += 4) {
    const c0 = lookup[base64.charCodeAt(i)];
    const c1 = lookup[base64.charCodeAt(i + 1)];
    const c2 = i + 2 < len ? lookup[base64.charCodeAt(i + 2)] : 0;
    const c3 = i + 3 < len ? lookup[base64.charCodeAt(i + 3)] : 0;

    bytes[p++] = (c0 << 2) | (c1 >> 4);
    if (i + 2 < len) bytes[p++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (i + 3 < len) bytes[p++] = ((c2 & 0x03) << 6) | c3;
  }

  return bytes;
}

// ============================================================================
// CameraSource - Live camera captures
// ============================================================================

/**
 * Image source for live camera captures
 */
export class CameraSource implements ImageSource {
  private uri: string;
  private deviceId: string;
  private flash: boolean;
  private cachedMetadata: CameraSourceMetadata | null = null;

  constructor(photoPath: string, deviceId: string = 'back', flash: boolean = false) {
    this.uri = normalizeFileUri(photoPath);
    this.deviceId = deviceId;
    this.flash = flash;
  }

  getType(): ImageSourceType {
    return 'camera';
  }

  getImageUri(): string {
    return this.uri;
  }

  canReplay(): boolean {
    return false;
  }

  async getPreprocessedTensor(): Promise<null> {
    return null;
  }

  getSavedLetterbox(): null {
    return null;
  }

  getSavedNativeTruth(): null {
    return null;
  }

  async getMetadata(): Promise<CameraSourceMetadata> {
    if (this.cachedMetadata) {
      return this.cachedMetadata;
    }

    // Use existing image metadata extraction
    const imageMeta = await buildImageMetaFromUri(this.uri);

    this.cachedMetadata = {
      sourceType: 'camera',
      uri: this.uri,
      width: imageMeta.width,
      height: imageMeta.height,
      orientation: imageMeta.orientation,
      timestamp: imageMeta.timestamp,
      deviceId: this.deviceId,
      flash: this.flash,
    };

    return this.cachedMetadata;
  }
}

// ============================================================================
// FixtureSource - Bundled/device test images
// ============================================================================

/**
 * Image source for test fixtures (bundled or device-loaded)
 */
export class FixtureSource implements ImageSource {
  private fixtureInfo: FixtureInfo;
  private cachedMetadata: FixtureSourceMetadata | null = null;

  constructor(fixture: FixtureInfo) {
    this.fixtureInfo = fixture;
  }

  getType(): ImageSourceType {
    return 'fixture';
  }

  getImageUri(): string {
    return normalizeFileUri(this.fixtureInfo.uri);
  }

  canReplay(): boolean {
    return false;
  }

  async getPreprocessedTensor(): Promise<null> {
    return null;
  }

  getSavedLetterbox(): null {
    return null;
  }

  getSavedNativeTruth(): null {
    return null;
  }

  async getMetadata(): Promise<FixtureSourceMetadata> {
    if (this.cachedMetadata) {
      return this.cachedMetadata;
    }

    const uri = this.getImageUri();
    const imageMeta = await buildImageMetaFromUri(uri);

    this.cachedMetadata = {
      sourceType: 'fixture',
      uri,
      width: imageMeta.width,
      height: imageMeta.height,
      orientation: imageMeta.orientation,
      timestamp: Date.now(),
      fixtureId: this.fixtureInfo.id,
      fixtureName: this.fixtureInfo.name,
      groundTruthPath: this.fixtureInfo.groundTruthLabels,
    };

    return this.cachedMetadata;
  }

  /**
   * Get the fixture info for this source
   */
  getFixtureInfo(): FixtureInfo {
    return this.fixtureInfo;
  }
}

// ============================================================================
// ReplaySource - Replay from saved sessions
// ============================================================================

/**
 * Image source for replaying saved sessions
 * Uses cached preprocessed tensor to skip native preprocessing
 */
export class ReplaySource implements ImageSource {
  private savedTensor: SavedTensor;
  private originalImageUri: string;
  private cachedTensor: Float32Array | null = null;

  constructor(savedTensor: SavedTensor, originalImageUri: string) {
    this.savedTensor = savedTensor;
    this.originalImageUri = normalizeFileUri(originalImageUri);
  }

  getType(): ImageSourceType {
    return 'replay';
  }

  getImageUri(): string {
    return this.originalImageUri;
  }

  canReplay(): boolean {
    return true;
  }

  getSavedLetterbox(): LetterboxParams {
    return this.savedTensor.letterboxParams;
  }

  getSavedNativeTruth(): SavedTensor['nativeTruth'] {
    return this.savedTensor.nativeTruth;
  }

  /**
   * Load preprocessed tensor from disk
   * Cached after first load
   */
  async getPreprocessedTensor(): Promise<Float32Array> {
    if (this.cachedTensor) {
      return this.cachedTensor;
    }

    console.log(`[ReplaySource] Loading tensor from: ${this.savedTensor.tensorPath}`);

    // Read tensor binary file (base64 encoded)
    const tensorBase64 = await RNFS.readFile(this.savedTensor.tensorPath, 'base64');
    const tensorBytes = base64Decode(tensorBase64);

    // Convert to Float32Array
    this.cachedTensor = new Float32Array(tensorBytes.buffer);

    // Validate shape
    const expectedElements = this.savedTensor.tensorShape.reduce((a, b) => a * b, 1);
    if (this.cachedTensor.length !== expectedElements) {
      throw new Error(
        `Tensor shape mismatch: expected ${expectedElements} elements, got ${this.cachedTensor.length}`
      );
    }

    console.log(`[ReplaySource] Tensor loaded: ${this.cachedTensor.length} elements`);
    return this.cachedTensor;
  }

  async getMetadata(): Promise<ReplaySourceMetadata> {
    return {
      sourceType: 'replay',
      uri: this.originalImageUri,
      width: this.savedTensor.nativeTruth.decodedW,
      height: this.savedTensor.nativeTruth.decodedH,
      orientation: 1, // Already normalized in saved tensor
      timestamp: Date.now(),
      originalSessionId: this.savedTensor.sessionId,
      tensorPath: this.savedTensor.tensorPath,
      skipPreprocessing: true,
    };
  }

  /**
   * Get the original session ID this replay is based on
   */
  getOriginalSessionId(): string {
    return this.savedTensor.sessionId;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a ReplaySource from a session ID
 * Returns null if the session doesn't have saved tensor data
 */
export async function createReplaySource(sessionId: string): Promise<ReplaySource | null> {
  const sessionDir = getSessionDir(sessionId);
  const tensorMetaPath = `${sessionDir}/saved_tensor.json`;

  // Check if saved tensor metadata exists
  const exists = await RNFS.exists(tensorMetaPath);
  if (!exists) {
    console.log(`[ImageSource] No saved tensor for session ${sessionId}`);
    return null;
  }

  try {
    // Load saved tensor metadata
    const metaJson = await RNFS.readFile(tensorMetaPath, 'utf8');
    const savedTensor: SavedTensor = JSON.parse(metaJson);

    // Verify tensor file exists
    const tensorExists = await RNFS.exists(savedTensor.tensorPath);
    if (!tensorExists) {
      console.error(`[ImageSource] Tensor file missing: ${savedTensor.tensorPath}`);
      return null;
    }

    // Get original image path
    const originalImagePath = `${sessionDir}/original.jpg`;
    const originalExists = await RNFS.exists(originalImagePath);
    if (!originalExists) {
      console.error(`[ImageSource] Original image missing: ${originalImagePath}`);
      return null;
    }

    console.log(`[ImageSource] Creating ReplaySource for session ${sessionId}`);
    return new ReplaySource(savedTensor, originalImagePath);
  } catch (error: any) {
    console.error(`[ImageSource] Failed to create ReplaySource: ${error.message}`);
    return null;
  }
}

/**
 * Create a CameraSource from a photo path
 */
export function createCameraSource(
  photoPath: string,
  deviceId?: string,
  flash?: boolean
): CameraSource {
  return new CameraSource(photoPath, deviceId, flash);
}

/**
 * Create a FixtureSource from fixture info
 */
export function createFixtureSource(fixture: FixtureInfo): FixtureSource {
  return new FixtureSource(fixture);
}

/**
 * Check if an ImageSource is a ReplaySource
 */
export function isReplaySource(source: ImageSource): source is ReplaySource {
  return source.getType() === 'replay';
}

/**
 * Check if an ImageSource is a CameraSource
 */
export function isCameraSource(source: ImageSource): source is CameraSource {
  return source.getType() === 'camera';
}

/**
 * Check if an ImageSource is a FixtureSource
 */
export function isFixtureSource(source: ImageSource): source is FixtureSource {
  return source.getType() === 'fixture';
}

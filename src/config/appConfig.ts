/**
 * Application Configuration - Centralized configuration for BookScanner
 *
 * Provides typed configuration for:
 * - Rectification service settings
 * - Preview mode pipeline settings
 * - Capture mode pipeline settings
 * - Debug/development settings
 */

/**
 * Pipeline mode configuration
 */
export interface PipelineModeConfig {
  /** Whether to write debug artifacts */
  writeArtifacts: boolean;
  /** NMS algorithm: 'aabb' (fast) or 'obb' (accurate) */
  nmsMode: 'aabb' | 'obb';
  /** Minimum score threshold for detections */
  scoreThreshold: number;
  /** Maximum detections to return */
  maxDetections: number;
  /** Skip rectification step */
  skipRectification: boolean;
}

/**
 * Rectification service configuration
 */
export interface RectifierConfig {
  /** Enable/disable rectification */
  enabled: boolean;
  /** Backend URL for rectification service */
  url: string;
  /** Request timeout in milliseconds */
  timeout: number;
}

/**
 * Debug and development configuration
 */
export interface DebugConfig {
  /** Force artifact writing even in preview mode */
  alwaysWriteArtifacts: boolean;
  /** Save preprocessed tensor for replay capability */
  saveTensorForReplay: boolean;
}

/**
 * Complete application configuration
 */
export interface AppConfig {
  rectifier: RectifierConfig;
  previewMode: PipelineModeConfig;
  captureMode: PipelineModeConfig;
  debug: DebugConfig;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: AppConfig = {
  rectifier: {
    enabled: true,
    url: 'http://localhost:8000',
    timeout: 30000,
  },
  previewMode: {
    writeArtifacts: false,
    nmsMode: 'aabb',
    scoreThreshold: 0.50,
    maxDetections: 30,
    skipRectification: true,
  },
  captureMode: {
    writeArtifacts: true,
    nmsMode: 'obb',
    scoreThreshold: 0.85,
    maxDetections: 50,
    skipRectification: false,
  },
  debug: {
    alwaysWriteArtifacts: false,
    saveTensorForReplay: true,
  },
};

// Module-level mutable config (initialized from defaults)
let currentConfig: AppConfig = { ...DEFAULT_CONFIG };

/**
 * Get the current application configuration
 */
export function getAppConfig(): AppConfig {
  return currentConfig;
}

/**
 * Update application configuration (partial update)
 */
export function setAppConfig(updates: Partial<AppConfig>): void {
  currentConfig = {
    ...currentConfig,
    ...updates,
    rectifier: updates.rectifier
      ? { ...currentConfig.rectifier, ...updates.rectifier }
      : currentConfig.rectifier,
    previewMode: updates.previewMode
      ? { ...currentConfig.previewMode, ...updates.previewMode }
      : currentConfig.previewMode,
    captureMode: updates.captureMode
      ? { ...currentConfig.captureMode, ...updates.captureMode }
      : currentConfig.captureMode,
    debug: updates.debug
      ? { ...currentConfig.debug, ...updates.debug }
      : currentConfig.debug,
  };
  console.log('[AppConfig] Configuration updated');
}

/**
 * Reset configuration to defaults
 */
export function resetAppConfig(): void {
  currentConfig = { ...DEFAULT_CONFIG };
  console.log('[AppConfig] Configuration reset to defaults');
}

/**
 * Get rectifier URL (convenience accessor)
 */
export function getRectifierUrl(): string {
  return currentConfig.rectifier.url;
}

/**
 * Set rectifier URL (convenience mutator)
 */
export function setRectifierUrl(url: string): void {
  currentConfig.rectifier.url = url;
  console.log(`[AppConfig] Rectifier URL set to: ${url}`);
}

/**
 * Check if rectification is enabled
 */
export function isRectificationEnabled(): boolean {
  return currentConfig.rectifier.enabled;
}

/**
 * Set rectification enabled state
 */
export function setRectificationEnabled(enabled: boolean): void {
  currentConfig.rectifier.enabled = enabled;
  console.log(`[AppConfig] Rectification ${enabled ? 'enabled' : 'disabled'}`);
}

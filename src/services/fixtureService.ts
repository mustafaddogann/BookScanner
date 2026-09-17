/**
 * Fixture service - manages bundled and device fixtures for testing
 *
 * DUAL-MODE FIXTURES:
 * 1. Bundled "golden" fixtures - shipped in app assets for baseline sanity
 * 2. Dev fixtures - loaded from device Documents/BookScanner/fixtures/ for fast iteration
 */

import { Platform } from 'react-native';
import RNFS from 'react-native-fs';
import type { FixtureInfo } from '../types';

// Directory for device fixtures
const DEV_FIXTURES_DIR = 'BookScanner/fixtures';

/**
 * Bundled fixture definitions
 * These are "golden" fixtures that ship with the app
 */
const BUNDLED_FIXTURES: FixtureInfo[] = [
  {
    id: 'bundled_bookshelf_1',
    name: 'Bookshelf Sample 1',
    uri: Platform.select({
      ios: 'bookshelf_1', // Will be loaded from asset catalog
      android: 'asset:/fixtures/bookshelf_1.jpg',
    }) || '',
    source: 'bundled',
    description: 'Standard bookshelf with multiple spines',
    expectedDetections: 5,
  },
  {
    id: 'bundled_angle_test',
    name: 'Angle Test Fixture',
    uri: Platform.select({
      ios: 'angle_test',
      android: 'asset:/fixtures/angle_test.jpg',
    }) || '',
    source: 'bundled',
    description: 'Fixture with clearly rotated rectangles for angle convention validation',
    expectedDetections: 3,
  },
  {
    id: 'bundled_single_spine',
    name: 'Single Spine',
    uri: Platform.select({
      ios: 'single_spine',
      android: 'asset:/fixtures/single_spine.jpg',
    }) || '',
    source: 'bundled',
    description: 'Single book spine for basic detection validation',
    expectedDetections: 1,
  },
];

/**
 * Get the device fixtures directory path
 */
export function getDevFixturesDir(): string {
  return `${RNFS.DocumentDirectoryPath}/${DEV_FIXTURES_DIR}`;
}

/**
 * Ensure device fixtures directory exists
 */
export async function ensureDevFixturesDir(): Promise<string> {
  const dir = getDevFixturesDir();
  const exists = await RNFS.exists(dir);
  if (!exists) {
    // Create parent and child directories
    const parentDir = `${RNFS.DocumentDirectoryPath}/BookScanner`;
    const parentExists = await RNFS.exists(parentDir);
    if (!parentExists) {
      await RNFS.mkdir(parentDir);
    }
    await RNFS.mkdir(dir);
    console.log(`[FixtureService] Created dev fixtures directory: ${dir}`);
  }
  return dir;
}

/**
 * Load dev fixtures from device storage
 */
export async function loadDevFixtures(): Promise<FixtureInfo[]> {
  const dir = await ensureDevFixturesDir();

  try {
    const items = await RNFS.readDir(dir);
    const fixtures: FixtureInfo[] = [];

    for (const item of items) {
      if (!item.isFile()) continue;

      const ext = item.name.toLowerCase().split('.').pop();
      if (!['jpg', 'jpeg', 'png'].includes(ext || '')) continue;

      const id = `dev_${item.name.replace(/\.[^/.]+$/, '')}`;
      const name = item.name.replace(/\.[^/.]+$/, '').replace(/_/g, ' ');

      // Check for companion JSON metadata
      const metadataPath = item.path.replace(/\.[^/.]+$/, '.json');
      let metadata: Partial<FixtureInfo> = {};

      if (await RNFS.exists(metadataPath)) {
        try {
          const metadataContent = await RNFS.readFile(metadataPath, 'utf8');
          metadata = JSON.parse(metadataContent);
        } catch {
          console.warn(`[FixtureService] Failed to parse metadata for ${item.name}`);
        }
      }

      // Check for ground truth labels file
      const labelsPath = item.path.replace(/\.[^/.]+$/, '_labels.txt');
      const hasLabels = await RNFS.exists(labelsPath);

      fixtures.push({
        id,
        name: metadata.name || name,
        uri: `file://${item.path}`,
        source: 'device',
        description: metadata.description,
        expectedDetections: metadata.expectedDetections,
        groundTruthLabels: hasLabels ? labelsPath : undefined,
      });
    }

    console.log(`[FixtureService] Loaded ${fixtures.length} dev fixtures`);
    return fixtures;
  } catch (error) {
    console.error('[FixtureService] Failed to load dev fixtures:', error);
    return [];
  }
}

/**
 * Load bundled fixtures
 * Returns fixtures that are available in app assets
 */
export async function loadBundledFixtures(): Promise<FixtureInfo[]> {
  // For now, return the predefined bundled fixtures
  // In production, you would verify each exists in the asset catalog
  console.log(`[FixtureService] Loaded ${BUNDLED_FIXTURES.length} bundled fixtures`);
  return BUNDLED_FIXTURES;
}

/**
 * Load all fixtures (bundled + device)
 */
export async function loadAllFixtures(): Promise<{
  bundled: FixtureInfo[];
  device: FixtureInfo[];
  all: FixtureInfo[];
}> {
  const [bundled, device] = await Promise.all([
    loadBundledFixtures(),
    loadDevFixtures(),
  ]);

  return {
    bundled,
    device,
    all: [...bundled, ...device],
  };
}

/**
 * Get a specific fixture by ID
 */
export async function getFixtureById(id: string): Promise<FixtureInfo | null> {
  const { all } = await loadAllFixtures();
  return all.find(f => f.id === id) || null;
}

/**
 * Add a dev fixture from a file path
 */
export async function addDevFixture(
  sourcePath: string,
  name: string,
  metadata?: Partial<FixtureInfo>
): Promise<FixtureInfo> {
  const dir = await ensureDevFixturesDir();

  // Generate filename from name
  const sanitizedName = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  const ext = sourcePath.toLowerCase().split('.').pop() || 'jpg';
  const filename = `${sanitizedName}.${ext}`;
  const destPath = `${dir}/${filename}`;

  // Copy file
  const cleanSource = sourcePath.startsWith('file://') ? sourcePath.slice(7) : sourcePath;
  await RNFS.copyFile(cleanSource, destPath);

  // Create fixture info
  const fixture: FixtureInfo = {
    id: `dev_${sanitizedName}`,
    name,
    uri: `file://${destPath}`,
    source: 'device',
    ...metadata,
  };

  // Write metadata JSON
  const metadataPath = `${dir}/${sanitizedName}.json`;
  await RNFS.writeFile(metadataPath, JSON.stringify(fixture, null, 2), 'utf8');

  console.log(`[FixtureService] Added dev fixture: ${name}`);
  return fixture;
}

/**
 * Delete a dev fixture
 */
export async function deleteDevFixture(id: string): Promise<void> {
  if (!id.startsWith('dev_')) {
    throw new Error('Can only delete device fixtures');
  }

  const { device } = await loadAllFixtures();
  const fixture = device.find(f => f.id === id);

  if (!fixture) {
    throw new Error(`Fixture not found: ${id}`);
  }

  const cleanUri = fixture.uri.startsWith('file://') ? fixture.uri.slice(7) : fixture.uri;

  // Delete image
  if (await RNFS.exists(cleanUri)) {
    await RNFS.unlink(cleanUri);
  }

  // Delete metadata JSON
  const metadataPath = cleanUri.replace(/\.[^/.]+$/, '.json');
  if (await RNFS.exists(metadataPath)) {
    await RNFS.unlink(metadataPath);
  }

  // Delete labels file if exists
  const labelsPath = cleanUri.replace(/\.[^/.]+$/, '_labels.txt');
  if (await RNFS.exists(labelsPath)) {
    await RNFS.unlink(labelsPath);
  }

  console.log(`[FixtureService] Deleted dev fixture: ${id}`);
}

/**
 * Get instructions for adding dev fixtures
 */
export function getDevFixtureInstructions(): string {
  const dir = getDevFixturesDir().replace(RNFS.DocumentDirectoryPath, 'Documents');
  return `
To add dev fixtures for testing:

1. Connect your device and open Files app (iOS) or file manager (Android)
2. Navigate to: ${dir}
3. Add image files (.jpg, .jpeg, .png)

Optional: Add companion files for each image:
- <name>.json - Metadata (description, expectedDetections, etc.)
- <name>_labels.txt - Ground truth labels for validation

Example metadata JSON:
{
  "name": "My Test Fixture",
  "description": "Description of the fixture",
  "expectedDetections": 5
}
`;
}

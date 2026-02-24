/**
 * ResultsScreen - Shows image with SVG overlay and tap selection
 */

import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Image,
  TouchableOpacity,
  FlatList,
  ScrollView,
  Dimensions,
  LayoutChangeEvent,
  ActivityIndicator,
  Share,
  Alert,
  Platform,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  ImageErrorEventData,
  NativeSyntheticEvent,
} from 'react-native';
import Svg, { Polygon, Circle, Text as SvgText } from 'react-native-svg';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList, OBBDetection, OBBCorners, ScreenMapping, SerializedFrameGeo, OCRResult, BookCandidate, ResolvedBook, AcceptanceDecision, VerificationFlag } from '../types';
import { obbToCorners, mapCornersToScreen, calculateScreenMapping } from '../utils/letterbox';
import { useAppStore, type SessionMeta, type DetectionRectifyInfo } from '../store/useAppStore';
import { readDebugManifest, getSessionDir } from '../services/debugArtifacts';
import { recognizeCropText, isTextRecognitionAvailable } from '../services/textRecognitionService';
import { ensureFileUri, getFilename } from '../utils/fileUri';
import { isMetadataResolutionEnabled } from '../config/debug';
import { retryMetadataResolution } from '../services/metadataResolutionOrchestrator';
import { BookCandidateCard } from '../components/BookCandidateCard';
import { useDebugStore } from '../store/useDebugStore';
import { BookCandidateDetailModal } from '../components/BookCandidateDetailModal';
import { EditCandidateFieldsModal } from '../components/EditCandidateFieldsModal';
import { saveCorrection, deleteCorrection, hasAppliedCorrection, hasStoredCorrection } from '../services/correctionsMemory';
import { confirmUserSelection } from '../services/booksCatalogService';
import RNFS from 'react-native-fs';
import {
  checkRescanStatus,
  getLastScannedImageUri,
  isAutoRescanEnabled,
  autoExportRejects,
  getServerUrl,
} from '../services/autoExportService';
import { colors, fonts, spacing, radii, shadows } from '../theme';

// Tab options for switching between overlay, crops, and books views
type ResultsTab = 'overlay' | 'crops' | 'books';

type BookCandidateListItem = BookCandidate & { candidateId: string };

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Results'>;
type ResultsRouteProp = RouteProp<RootStackParamList, 'Results'>;

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export function ResultsScreen(): React.JSX.Element {
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<ResultsRouteProp>();
  const { sessionId } = route.params;

  const {
    detections,
    selectedDetectionIndex,
    setSelectedDetection,
    currentSession,
    sessionMeta,
  } = useAppStore();

  // Diagnostics enabled from user settings
  const diagnosticsEnabled = useDebugStore((state) => state.diagnosticsEnabled);
  const autoRetryEnabled = useDebugStore((state) => state.autoRetryEnabled);
  const autoRetryInterval = useDebugStore((state) => state.autoRetryInterval);
  const setAutoRetryEnabled = useDebugStore((state) => state.setAutoRetryEnabled);
  const showDiagnosticsUI = __DEV__ && diagnosticsEnabled;

  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [containerLayout, setContainerLayout] = useState<{ width: number; height: number } | null>(null);
  const [screenMapping, setScreenMapping] = useState<ScreenMapping | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Tab and crop selection state
  const [activeTab, setActiveTab] = useState<ResultsTab>('books');
  const [selectedCropIndex, setSelectedCropIndex] = useState<number | null>(null);
  const [diagnosticsVisible, setDiagnosticsVisible] = useState(false);

  // Debug filter for book candidates (reject, suggested, accept, all)
  type StatusFilter = 'all' | 'reject' | 'suggested' | 'accept';
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // Get rectification results from sessionMeta
  const rectificationResults = sessionMeta?.rectificationResults || [];
  const rectificationSummary = sessionMeta?.rectificationSummary;
  const hasSuccessfulCrops = rectificationSummary ? rectificationSummary.succeeded > 0 :
    rectificationResults.some(r => r.cropUri && r.rectificationMethod !== 'skipped');

  // Get OCR results from sessionMeta
  const ocrResults = sessionMeta?.ocrResultsByCropIndex || {};
  const ocrSummary = sessionMeta?.ocrSummary;
  const userEdits = sessionMeta?.userEdits || {};

  // Get book candidates from sessionMeta (Gate 7)
  const bookCandidates = useMemo(() => {
    const candidates = sessionMeta?.bookCandidates ?? [];
    return candidates.map((candidate) => ({
      ...candidate,
      candidateId: (candidate as { candidateId?: string }).candidateId ?? candidate.id,
    }));
  }, [sessionMeta?.bookCandidates]);
  const bookCandidatesSummary = sessionMeta?.bookCandidatesSummary;

  // Filter book candidates by status for debugging
  const filteredBookCandidates = useMemo(() => {
    if (statusFilter === 'all') return bookCandidates;
    return bookCandidates.filter((candidate) => {
      const decision = candidate.resolverDecision;
      // Accept = only 'accept'
      if (statusFilter === 'accept') return decision === 'accept';
      // Suggested = only 'suggested'
      if (statusFilter === 'suggested') return decision === 'suggested';
      // Reject = everything else (reject, pending, error, disabled, offline, undefined)
      if (statusFilter === 'reject') {
        return decision !== 'accept' && decision !== 'suggested';
      }
      return true;
    });
  }, [bookCandidates, statusFilter]);

  // Get metadata resolution state (Gate 8+) - feature flagged
  const metadataResolution = sessionMeta?.metadataResolution;
  const evidenceSummary = sessionMeta?.evidenceSummary;
  const metadataQueuedForOffline = sessionMeta?.metadataQueuedForOffline;

  // State for OCR processing
  const [ocrProcessing, setOcrProcessing] = useState<number | null>(null);
  const [ocrAvailable, setOcrAvailable] = useState<boolean | null>(null);

  // State for edit modal
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editingCropIndex, setEditingCropIndex] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editAuthor, setEditAuthor] = useState('');

  // State for full-screen crop preview
  const [previewModalVisible, setPreviewModalVisible] = useState(false);
  const [previewCropIndex, setPreviewCropIndex] = useState<number | null>(null);

  // State for metadata resolution UI (Gate 8+)
  const [metadataRetrying, setMetadataRetrying] = useState(false);
  const [userSelectedBook, setUserSelectedBook] = useState<ResolvedBook | null>(null);
  const [bookDetailCandidate, setBookDetailCandidate] = useState<BookCandidateListItem | null>(null);
  const [isAcceptingBook, setIsAcceptingBook] = useState(false);
  const [editCandidateModalVisible, setEditCandidateModalVisible] = useState(false);
  const [editCandidateCropIndex, setEditCandidateCropIndex] = useState<number | null>(null);
  const [editCandidateTitle, setEditCandidateTitle] = useState('');
  const [editCandidateAuthor, setEditCandidateAuthor] = useState('');
  const [editingCandidate, setEditingCandidate] = useState<BookCandidateListItem | null>(null);

  // Track image load errors per crop index
  const [imageLoadErrors, setImageLoadErrors] = useState<Record<number, string>>({});

  // Fallback rectification results loaded from disk
  const [fallbackRectResults, setFallbackRectResults] = useState<DetectionRectifyInfo[] | null>(null);

  // Track if fallback was already attempted for this sessionId to prevent infinite loops
  const fallbackAttemptedRef = useRef<string | null>(null);

  // Check OCR availability on mount
  useEffect(() => {
    isTextRecognitionAvailable().then(result => {
      setOcrAvailable(result.available);
    });
  }, []);

  // Auto-retry timer for automated testing
  useEffect(() => {
    if (!autoRetryEnabled || metadataRetrying) return;

    const timer = setInterval(() => {
      console.log('[AutoRetry] Triggering automatic retry...');
      // Find and call the retry handler
      const currentMeta = useAppStore.getState().sessionMeta;
      // Count books that need fixing (everything except accept and suggested)
      const rejectCount = currentMeta?.bookCandidates?.filter((c) => {
        const decision = c.resolverDecision;
        return decision !== 'accept' && decision !== 'suggested';
      }).length || 0;

      if (rejectCount > 0) {
        console.log(`[AutoRetry] ${rejectCount} rejects found, retrying...`);
        // Trigger retry via the handler (will be called below)
        setMetadataRetrying(true);
        retryMetadataResolution({
          sessionId,
          rectificationResults: currentMeta?.rectificationResults || [],
          ocrResultsByCropIndex: currentMeta?.ocrResultsByCropIndex || {},
          bookCandidates: currentMeta?.bookCandidates || [],
        }).then((result) => {
          console.log('[AutoRetry] Retry complete');
          useAppStore.getState().setSessionMeta({
            metadataResolution: result.resolutionState,
            bookCandidates: result.resolutionState?.resolvedCandidates,
          });
          // Export rejects to Telegram for ClawdBot analysis
          const candidates = result.resolutionState?.resolvedCandidates || [];
          autoExportRejects(sessionId, candidates);
        }).catch((err) => {
          console.error('[AutoRetry] Retry failed:', err);
        }).finally(() => {
          setMetadataRetrying(false);
        });
      } else {
        console.log('[AutoRetry] No rejects, disabling auto-retry');
        setAutoRetryEnabled(false);
      }
    }, autoRetryInterval * 1000);

    return () => clearInterval(timer);
  }, [autoRetryEnabled, autoRetryInterval, metadataRetrying, sessionId, setAutoRetryEnabled]);

  // Auto-rescan polling: Check server for rebuild signals
  // When code changes are deployed, server signals the app to rescan
  useEffect(() => {
    if (!autoRetryEnabled) return;

    const pollForRescan = async () => {
      try {
        const status = await checkRescanStatus();
        if (status.rescan && status.auto_retry) {
          console.log('[AutoRescan] Server signaled rescan:', status.reason);
          const imageUri = getLastScannedImageUri();
          if (imageUri) {
            // Clear the rescan flag on server first
            const serverUrl = getServerUrl();
            if (serverUrl) {
              try {
                const baseUrl = serverUrl.replace(/\/upload$/, '');
                await fetch(`${baseUrl}/clear-rescan`, { method: 'POST' });
              } catch (e) {
                console.warn('[AutoRescan] Failed to clear rescan flag:', e);
              }
            }
            // Navigate directly to scanner - no alert blocking
            console.log('[AutoRescan] Auto-navigating to rescan with:', imageUri);
            navigation.navigate('Scanner', { importUri: imageUri });
          }
        }
      } catch (error) {
        console.warn('[AutoRescan] Poll error:', error);
      }
    };

    // Poll every 30 seconds
    const timer = setInterval(pollForRescan, 30000);
    // Initial check after 5 seconds
    const initialCheck = setTimeout(pollForRescan, 5000);

    return () => {
      clearInterval(timer);
      clearTimeout(initialCheck);
    };
  }, [autoRetryEnabled, navigation]);

  // TASK E: Defensive verification and fallback loader
  // If store has no rectificationResults but crops exist on disk, load them ONCE
  useEffect(() => {
    async function verifyAndFallbackLoad() {
      const sessionDir = getSessionDir(sessionId);
      const cropsDir = `${sessionDir}/crops`;

      // Get FRESH state to avoid stale closure issues
      const currentMeta = useAppStore.getState().sessionMeta;
      const currentRectResults = currentMeta?.rectificationResults || [];

      // Only log verification once per sessionId
      const isFirstCheck = fallbackAttemptedRef.current !== sessionId;
      if (isFirstCheck) {
        console.log(`[Results] === CROPS VERIFICATION (sessionId: ${sessionId.substring(0, 8)}...) ===`);
        console.log(`[Results] rectificationResults from store: ${currentRectResults.length}`);
      }

      if (currentRectResults.length > 0) {
        // Store has results - no fallback needed
        if (isFirstCheck) {
          const first = currentRectResults[0];
          console.log(`[Results] First cropUri: ${first.cropUri || 'null'}`);
          fallbackAttemptedRef.current = sessionId;
        }
        return;
      }

      // Check if we already attempted fallback for this sessionId
      if (fallbackAttemptedRef.current === sessionId) {
        // Already attempted fallback - don't repeat
        return;
      }

      // Mark fallback as attempted BEFORE starting (prevents race conditions)
      fallbackAttemptedRef.current = sessionId;
      console.log(`[Results] No rectificationResults in store, attempting disk fallback (once)...`);

      try {
        const dirExists = await RNFS.exists(cropsDir);
        if (!dirExists) {
          console.log(`[Results] Crops directory does not exist: ${cropsDir}`);
          return;
        }

        const files = await RNFS.readDir(cropsDir);
        const cropFiles = files.filter(f =>
          f.isFile() && f.name.startsWith('crop_') && f.name.endsWith('.jpg')
        ).sort((a, b) => {
          // Sort by detection index: crop_0.jpg, crop_1.jpg, etc.
          const indexA = parseInt(a.name.replace('crop_', '').replace('.jpg', ''), 10);
          const indexB = parseInt(b.name.replace('crop_', '').replace('.jpg', ''), 10);
          return indexA - indexB;
        });

        console.log(`[Results] Found ${cropFiles.length} crop files on disk`);

        if (cropFiles.length > 0) {
          const fallbackResults: DetectionRectifyInfo[] = await Promise.all(
            cropFiles.map(async (file, idx) => {
              const indexMatch = file.name.match(/crop_(\d+)\.jpg/);
              const detectionIndex = indexMatch ? parseInt(indexMatch[1], 10) : idx;
              const cropPath = file.path;
              const cropUri = ensureFileUri(cropPath);

              // Try to get dimensions via Image.getSize
              let width = 0;
              let height = 0;
              try {
                await new Promise<void>((resolve) => {
                  Image.getSize(
                    cropUri,
                    (w, h) => { width = w; height = h; resolve(); },
                    () => { resolve(); }
                  );
                });
              } catch {
                // Ignore dimension fetch errors
              }

              return {
                detectionIndex,
                cropPath,
                cropUri,
                cropWidth: width,
                cropHeight: height,
                rectificationMethod: 'native_opencv',
              };
            })
          );

          console.log(`[Results] Loaded ${fallbackResults.length} crops from disk fallback`);

          // Write fallback results BACK to store (merge semantics)
          // This ensures subsequent renders use store instead of repeating fallback
          useAppStore.getState().setSessionMeta({
            rectificationResults: fallbackResults,
            rectificationSummary: {
              total: fallbackResults.length,
              succeeded: fallbackResults.filter(r => r.cropUri).length,
              skipped: fallbackResults.filter(r => !r.cropUri).length,
            },
          });

          // Also set local state for immediate UI update
          setFallbackRectResults(fallbackResults);
        }
      } catch (err: any) {
        console.warn(`[Results] Fallback crop loading failed: ${err.message}`);
      }
    }

    if (!loading) {
      verifyAndFallbackLoad();
    }
    // IMPORTANT: Only depend on sessionId and loading, NOT rectificationResults
    // This prevents infinite loops when store is updated
  }, [sessionId, loading]);

  // Effective rectification results: prefer store, fallback to disk-loaded
  const effectiveRectResults = useMemo(() => {
    if (rectificationResults.length > 0) {
      return rectificationResults;
    }
    return fallbackRectResults || [];
  }, [rectificationResults, fallbackRectResults]);

  // Recompute hasSuccessfulCrops using effectiveRectResults
  const effectiveHasSuccessfulCrops = useMemo(() => {
    return effectiveRectResults.some(r => r.cropUri && r.rectificationMethod !== 'skipped');
  }, [effectiveRectResults]);

  // Load session data with robust guards
  // PRIORITY: 1) Store sessionMeta (in-memory) 2) debug_manifest.json (legacy fallback)
  useEffect(() => {
    async function loadSession() {
      try {
        const sessionDir = getSessionDir(sessionId);

        // ================================================================
        // STEP 1: Try to get geometry from in-memory store (PREFERRED)
        // ================================================================
        let foundImageUri: string | null = null;
        let foundDimensions: { width: number; height: number } | null = null;
        let usedStore = false;

        if (sessionMeta) {
          console.log('[Results] Using sessionMeta from store (single source of truth)');

          // Get dimensions from store
          if (sessionMeta.imageDimensions) {
            foundDimensions = sessionMeta.imageDimensions;
            console.log(`[Results] Store dimensions: ${foundDimensions.width}x${foundDimensions.height}`);
          } else if (sessionMeta.frameGeo) {
            foundDimensions = {
              width: sessionMeta.frameGeo.pixelW,
              height: sessionMeta.frameGeo.pixelH,
            };
            console.log(`[Results] Store frameGeo dimensions: ${foundDimensions.width}x${foundDimensions.height}`);
          }

          // Get image path from store - prefer display image for performance
          if (sessionMeta.displayImagePath) {
            const displayExists = await RNFS.exists(sessionMeta.displayImagePath);
            if (displayExists) {
              foundImageUri = `file://${sessionMeta.displayImagePath}`;
              console.log('[Results] Using displayImagePath from store (optimized)');
            }
          }
          // Fall back to normalized image if no display image
          if (!foundImageUri && sessionMeta.normalizedImagePath) {
            const normalizedExists = await RNFS.exists(sessionMeta.normalizedImagePath);
            if (normalizedExists) {
              foundImageUri = `file://${sessionMeta.normalizedImagePath}`;
              console.log('[Results] Using normalizedImagePath from store');
            }
          }

          usedStore = !!foundDimensions;
        }

        // ================================================================
        // STEP 2: Find display image (if not found from store)
        // ================================================================
        if (!foundImageUri) {
          // Priority order for display image:
          // 1. display.jpg (downscaled for performance, avoids PERF ASSETS warnings)
          // 2. input_normalized.jpg (EXIF-corrected, matches detection coordinates)
          // 3. original.jpg (raw camera output)
          // 4. original.png (alternative format)
          //
          // Note: Detection coordinates are in original image space.
          // Since display.jpg has the same aspect ratio, the screen mapping
          // using original dimensions will still correctly align overlays.
          const displayPath = `${sessionDir}/display.jpg`;
          const normalizedPath = `${sessionDir}/input_normalized.jpg`;
          const jpgPath = `${sessionDir}/original.jpg`;
          const pngPath = `${sessionDir}/original.png`;

          if (await RNFS.exists(displayPath)) {
            foundImageUri = `file://${displayPath}`;
            console.log('[Results] Using display.jpg for optimized rendering');
          } else if (await RNFS.exists(normalizedPath)) {
            foundImageUri = `file://${normalizedPath}`;
            console.log('[Results] Using input_normalized.jpg for display');
          } else if (await RNFS.exists(jpgPath)) {
            foundImageUri = `file://${jpgPath}`;
            console.log('[Results] Falling back to original.jpg');
          } else if (await RNFS.exists(pngPath)) {
            foundImageUri = `file://${pngPath}`;
            console.log('[Results] Falling back to original.png');
          }
        }

        setImageUri(foundImageUri);

        // ================================================================
        // STEP 3: Fall back to debug_manifest.json for legacy sessions
        // ================================================================
        if (!foundDimensions) {
          console.log('[Results] Store empty, falling back to debug_manifest.json');

          try {
            const manifest = await readDebugManifest(sessionId);

            if (manifest) {
              // Try FrameGeo first
              const frameGeo = manifest.frameGeo as SerializedFrameGeo | undefined;
              if (frameGeo && typeof frameGeo.pixelW === 'number' && typeof frameGeo.pixelH === 'number') {
                foundDimensions = { width: frameGeo.pixelW, height: frameGeo.pixelH };
                console.log(`[Results] Manifest frameGeo dimensions: ${foundDimensions.width}x${foundDimensions.height}`);
              } else if (manifest.imageMeta && typeof manifest.imageMeta.width === 'number') {
                foundDimensions = { width: manifest.imageMeta.width, height: manifest.imageMeta.height };
                console.log(`[Results] Manifest imageMeta dimensions: ${foundDimensions.width}x${foundDimensions.height}`);
              }

              // Load detections from manifest if store is empty
              if (detections.length === 0) {
                const manifestDetections = manifest.detectionsOriginal || manifest.detectionsFrameSpace || [];
                console.log(`[Results] Loading ${manifestDetections.length} detections from manifest`);
                if (Array.isArray(manifestDetections)) {
                  useAppStore.getState().setDetections(manifestDetections);
                }
              }
            }
          } catch (manifestError: any) {
            // debug_manifest.json may not exist if DEBUG_ARTIFACTS_ENABLED=false
            // This is expected - not an error
            console.log(`[Results] No debug_manifest.json (artifacts disabled): ${manifestError.message}`);
          }
        }

        // ================================================================
        // STEP 4: Last resort - use Image.getSize
        // ================================================================
        if (!foundDimensions && foundImageUri) {
          console.warn('[Results] No dimensions from store or manifest, using Image.getSize fallback');
          try {
            const { Image: RNImage } = await import('react-native');
            await new Promise<void>((resolve, reject) => {
              RNImage.getSize(
                foundImageUri!,
                (w, h) => {
                  console.warn(`[Results] Image.getSize: ${w}x${h} - coordinates may not match detections!`);
                  foundDimensions = { width: w, height: h };
                  resolve();
                },
                (err) => {
                  console.error('[Results] Image.getSize failed:', err);
                  reject(err);
                }
              );
            });
          } catch {
            console.warn('[Results] Could not determine image dimensions');
          }
        }

        // Set dimensions
        if (foundDimensions) {
          setImageDimensions(foundDimensions);
        }

        // Log detection count
        console.log(`[Results] ${detections.length} detections available for rendering`);

        // Show warning if no dimensions found
        if (!foundDimensions && !foundImageUri) {
          setLoadError('Session data not found. The session may have been deleted.');
        }
      } catch (error: any) {
        console.error('[Results] Failed to load session:', error);
        setLoadError(`Failed to load session: ${error.message}`);
      } finally {
        setLoading(false);
      }
    }

    loadSession();
  }, [sessionId, sessionMeta]);

  // Calculate screen mapping when container layout changes
  useEffect(() => {
    if (!containerLayout || !imageDimensions) return;

    const mapping = calculateScreenMapping(
      imageDimensions.width,
      imageDimensions.height,
      containerLayout.width,
      containerLayout.height,
      containerLayout.width,
      containerLayout.height
    );

    setScreenMapping(mapping);
    console.log('[Results] Screen mapping calculated:', mapping);
  }, [containerLayout, imageDimensions]);

  // Handle container layout
  const handleContainerLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setContainerLayout({ width, height });
  }, []);

  // Handle detection tap
  const handleDetectionTap = useCallback((index: number) => {
    setSelectedDetection(selectedDetectionIndex === index ? null : index);
  }, [selectedDetectionIndex, setSelectedDetection]);

  // Convert OBB to screen-space polygon points
  const getPolygonPoints = useCallback((obb: OBBDetection, index: number): string => {
    if (!screenMapping) return '';

    const corners = obbToCorners(obb);
    const screenCorners = mapCornersToScreen(corners, screenMapping);

    // Debug log for first few detections
    if (index < 3) {
      console.log(`[Results] Detection ${index}:`);
      console.log(`  OBB: cx=${obb.cx.toFixed(1)}, cy=${obb.cy.toFixed(1)}, w=${obb.width.toFixed(1)}, h=${obb.height.toFixed(1)}, angle=${obb.angle.toFixed(4)} rad (${(obb.angle * 180 / Math.PI).toFixed(1)}°)`);
      console.log(`  Corners (image): TL=(${corners.topLeft.x.toFixed(1)},${corners.topLeft.y.toFixed(1)}), TR=(${corners.topRight.x.toFixed(1)},${corners.topRight.y.toFixed(1)})`);
      console.log(`  Corners (screen): TL=(${screenCorners.topLeft.x.toFixed(1)},${screenCorners.topLeft.y.toFixed(1)}), TR=(${screenCorners.topRight.x.toFixed(1)},${screenCorners.topRight.y.toFixed(1)})`);
    }

    return [
      `${screenCorners.topLeft.x},${screenCorners.topLeft.y}`,
      `${screenCorners.topRight.x},${screenCorners.topRight.y}`,
      `${screenCorners.bottomRight.x},${screenCorners.bottomRight.y}`,
      `${screenCorners.bottomLeft.x},${screenCorners.bottomLeft.y}`,
    ].join(' ');
  }, [screenMapping]);

  // Get center point in screen space for label
  const getScreenCenter = useCallback((obb: OBBDetection): { x: number; y: number } => {
    if (!screenMapping) return { x: 0, y: 0 };

    return {
      x: obb.cx * screenMapping.scale + screenMapping.offsetX,
      y: obb.cy * screenMapping.scale + screenMapping.offsetY,
    };
  }, [screenMapping]);

  // Handle back navigation
  const handleBack = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  // Handle crop selection - also select corresponding detection
  const handleCropTap = useCallback((index: number) => {
    const newIndex = selectedCropIndex === index ? null : index;
    setSelectedCropIndex(newIndex);
    // Also select the corresponding detection
    setSelectedDetection(newIndex);
  }, [selectedCropIndex, setSelectedDetection]);

  // Share a crop image
  const handleShareCrop = useCallback(async (cropInfo: DetectionRectifyInfo) => {
    if (!cropInfo.cropUri) {
      Alert.alert('Share Unavailable', 'This crop was not generated.');
      return;
    }

    try {
      const filePath = cropInfo.cropUri.replace('file://', '');

      // Verify file exists
      const exists = await RNFS.exists(filePath);
      if (!exists) {
        Alert.alert('File Not Found', 'The crop file could not be found.');
        return;
      }

      if (Platform.OS === 'ios') {
        await Share.share({
          url: cropInfo.cropUri,
        });
      } else {
        // Android - share as file URI
        await Share.share({
          message: `Book spine crop ${cropInfo.detectionIndex + 1}`,
          url: cropInfo.cropUri,
        });
      }
    } catch (error: any) {
      if (error.message !== 'User did not share') {
        console.error('[Results] Share error:', error);
        Alert.alert('Share Failed', error.message || 'Failed to share the crop.');
      }
    }
  }, []);

  // Share all successful crops
  const handleShareAllCrops = useCallback(async () => {
    const successfulCrops = effectiveRectResults.filter(r => r.cropUri && r.rectificationMethod !== 'skipped');
    if (successfulCrops.length === 0) {
      Alert.alert('No Crops', 'No successful crops available to share.');
      return;
    }

    if (successfulCrops.length === 1) {
      // Single crop - share directly
      await handleShareCrop(successfulCrops[0]);
      return;
    }

    // Multiple crops - on iOS, share all URLs
    if (Platform.OS === 'ios') {
      try {
        // iOS can share multiple files using activityItems (not directly in Share API)
        // For now, show alert to share individually
        Alert.alert(
          'Share Crops',
          `${successfulCrops.length} crops available. Tap on individual crops to share them.`,
          [{ text: 'OK' }]
        );
      } catch (error: any) {
        console.error('[Results] Share all error:', error);
      }
    } else {
      Alert.alert(
        'Share Crops',
        `${successfulCrops.length} crops available. Tap on individual crops to share them.`,
        [{ text: 'OK' }]
      );
    }
  }, [effectiveRectResults, handleShareCrop]);

  // Run OCR on a single crop
  const handleRunOCR = useCallback(async (cropIndex: number) => {
    const cropInfo = effectiveRectResults[cropIndex];
    if (!cropInfo?.cropUri || !ocrAvailable) {
      Alert.alert('OCR Unavailable', 'Cannot run OCR on this crop.');
      return;
    }

    setOcrProcessing(cropIndex);

    try {
      const result = await recognizeCropText(cropInfo.cropUri, sessionId, cropIndex);

      // Update sessionMeta with new OCR result
      const currentMeta = useAppStore.getState().sessionMeta;
      if (currentMeta) {
        const newOcrResults = { ...currentMeta.ocrResultsByCropIndex, [cropIndex]: result };
        useAppStore.getState().setSessionMeta({
          ...currentMeta,
          ocrResultsByCropIndex: newOcrResults,
        });
      }

      if (result.ok) {
        console.log(`[Results] OCR completed for crop ${cropIndex}: "${result.titleCandidate}"`);
      } else {
        console.log(`[Results] OCR failed for crop ${cropIndex}: ${result.error || result.skippedReason}`);
      }
    } catch (error: any) {
      console.error(`[Results] OCR error for crop ${cropIndex}:`, error);
      Alert.alert('OCR Error', error.message || 'Failed to run OCR');
    } finally {
      setOcrProcessing(null);
    }
  }, [effectiveRectResults, sessionId, ocrAvailable]);

  // Update user edit for a crop
  const handleUpdateUserEdit = useCallback((cropIndex: number, field: 'title' | 'author', value: string) => {
    const currentMeta = useAppStore.getState().sessionMeta;
    if (!currentMeta) return;

    const currentEdits = currentMeta.userEdits || {};
    const cropEdits = currentEdits[cropIndex] || {};

    useAppStore.getState().setSessionMeta({
      ...currentMeta,
      userEdits: {
        ...currentEdits,
        [cropIndex]: {
          ...cropEdits,
          [field]: value,
        },
      },
    });
  }, []);

  // Get display title/author for a crop (user edit takes precedence)
  const getDisplayText = useCallback((cropIndex: number): { title: string | null; author: string | null } => {
    const edit = userEdits[cropIndex];
    const ocr = ocrResults[cropIndex];

    return {
      title: edit?.title ?? ocr?.titleCandidate ?? null,
      author: edit?.author ?? ocr?.authorCandidate ?? null,
    };
  }, [userEdits, ocrResults]);

  // Open edit modal for a crop
  const handleOpenEditModal = useCallback((cropIndex: number) => {
    const displayText = getDisplayText(cropIndex);
    setEditingCropIndex(cropIndex);
    setEditTitle(displayText.title || '');
    setEditAuthor(displayText.author || '');
    setEditModalVisible(true);
  }, [getDisplayText]);

  // Close edit modal
  const handleCloseEditModal = useCallback(() => {
    setEditModalVisible(false);
    setEditingCropIndex(null);
    setEditTitle('');
    setEditAuthor('');
  }, []);

  // Save edits from modal
  const handleSaveEdits = useCallback(() => {
    if (editingCropIndex === null) return;

    const currentMeta = useAppStore.getState().sessionMeta;
    if (!currentMeta) {
      handleCloseEditModal();
      return;
    }

    const currentEdits = currentMeta.userEdits || {};

    useAppStore.getState().setSessionMeta({
      ...currentMeta,
      userEdits: {
        ...currentEdits,
        [editingCropIndex]: {
          title: editTitle.trim() || undefined,
          author: editAuthor.trim() || undefined,
        },
      },
    });

    console.log(`[Results] Saved edits for crop ${editingCropIndex}: title="${editTitle}", author="${editAuthor}"`);
    handleCloseEditModal();
  }, [editingCropIndex, editTitle, editAuthor, handleCloseEditModal]);

  // Handle image load error for a crop
  const handleCropImageError = useCallback((
    cropIndex: number,
    cropUri: string | null,
    error: NativeSyntheticEvent<ImageErrorEventData>
  ) => {
    const errorMsg = error.nativeEvent?.error || 'Unknown error';
    console.error(`[Results] Image load FAILED for crop ${cropIndex}: ${errorMsg}`);
    console.error(`[Results]   URI: ${cropUri || 'null'}`);

    setImageLoadErrors(prev => ({
      ...prev,
      [cropIndex]: errorMsg,
    }));
  }, []);

  // Open full-screen preview for a crop
  const handleOpenPreview = useCallback((cropIndex: number) => {
    setPreviewCropIndex(cropIndex);
    setPreviewModalVisible(true);
  }, []);

  // Close full-screen preview
  const handleClosePreview = useCallback(() => {
    setPreviewModalVisible(false);
    setPreviewCropIndex(null);
  }, []);

  // Get rotation for a crop (from OCR result if available)
  const getCropRotation = useCallback((cropIndex: number): number => {
    const ocrResult = ocrResults[cropIndex];
    if (ocrResult?.ok && typeof ocrResult.chosenRotation === 'number') {
      return ocrResult.chosenRotation;
    }
    return 0;
  }, [ocrResults]);

  // Calculate if a crop is very wide (needs rotation for display)
  const isVeryWideCrop = useCallback((width: number, height: number): boolean => {
    return width > height * 2;
  }, []);

  // Handle retry metadata resolution (Gate 8+)
  const handleRetryMetadata = useCallback(async () => {
    if (!isMetadataResolutionEnabled() || metadataRetrying) return;

    const currentMeta = useAppStore.getState().sessionMeta;
    const rectResults = currentMeta?.rectificationResults || [];
    const ocrByCrop = currentMeta?.ocrResultsByCropIndex || {};
    const bookCands = currentMeta?.bookCandidates || [];

    if (rectResults.length === 0 || Object.keys(ocrByCrop).length === 0) {
      Alert.alert('Cannot Retry', 'No OCR results available for metadata resolution.');
      return;
    }

    setMetadataRetrying(true);

    try {
      const result = await retryMetadataResolution({
        sessionId,
        rectificationResults: rectResults,
        ocrResultsByCropIndex: ocrByCrop,
        bookCandidates: bookCands,
      });

      // Update store with new results
      useAppStore.getState().setSessionMeta({
        evidenceSummary: result.evidenceSummary,
        metadataResolution: result.resolutionState,
        metadataQueuedForOffline: result.queuedForOffline,
      });

      // Export rejects to Telegram for ClawdBot analysis
      const candidates = result.resolutionState?.resolvedCandidates || [];
      autoExportRejects(sessionId, candidates);

      console.log(`[Results] Metadata retry complete: ${result.decision.action}`);
    } catch (error: any) {
      console.error('[Results] Metadata retry failed:', error);
      Alert.alert('Retry Failed', error.message || 'Failed to resolve metadata.');
    } finally {
      setMetadataRetrying(false);
    }
  }, [sessionId, metadataRetrying]);

  // Handle export rejects for debugging
  const handleExportRejects = useCallback(async () => {
    const rejects = bookCandidates.filter(c => c.resolverDecision === 'reject');
    if (rejects.length === 0) {
      Alert.alert('No Rejects', 'No rejected books to export.');
      return;
    }

    const exportData = {
      sessionId,
      exportedAt: new Date().toISOString(),
      totalBooks: bookCandidates.length,
      rejectCount: rejects.length,
      rejects: rejects.map((candidate, idx) => ({
        bookNumber: idx + 1,
        id: candidate.id,
        mergedText: candidate.evidence?.mergedTextBlock || '',
        resolverDecision: candidate.resolverDecision,
        resolverDecisionReason: candidate.resolverDecisionReason,
        evidenceSearchDebug: candidate.evidenceSearchDebug,
        hypothesis: candidate.hypothesis,
        resolvedBook: candidate.resolvedBook,
        resolverSuggestions: candidate.resolverSuggestions,
      })),
    };

    const filename = `rejects_${sessionId}_${Date.now()}.json`;
    const filepath = `${RNFS.DocumentDirectoryPath}/${filename}`;

    try {
      await RNFS.writeFile(filepath, JSON.stringify(exportData, null, 2), 'utf8');

      // Share the file
      await Share.share({
        title: 'Export Rejected Books',
        message: `Exported ${rejects.length} rejected books for debugging`,
        url: `file://${filepath}`,
      });

      console.log(`[Results] Exported rejects to: ${filepath}`);
    } catch (error: any) {
      console.error('[Results] Export failed:', error);
      Alert.alert('Export Failed', error.message || 'Failed to export rejects.');
    }
  }, [bookCandidates, sessionId]);

  // Handle user selecting a book from suggestions (Gate 8+)
  const handleSelectBook = useCallback((book: ResolvedBook) => {
    setUserSelectedBook(book);
    // Update store to record user selection
    const currentMeta = useAppStore.getState().sessionMeta;
    if (currentMeta?.metadataResolution) {
      useAppStore.getState().setSessionMeta({
        metadataResolution: {
          ...currentMeta.metadataResolution,
          resolvedBook: book,
        },
      });
    }
    console.log(`[Results] User selected book: "${book.title}"`);
  }, []);

  const getCandidateEditIndex = useCallback((candidate: BookCandidateListItem): number | null => {
    if (candidate.cropIndices?.length) return candidate.cropIndices[0];
    return null;
  }, []);

  const getCandidateDisplay = useCallback((candidate: BookCandidateListItem) => {
    const editIndex = getCandidateEditIndex(candidate);
    const edit = editIndex !== null ? userEdits[editIndex] : undefined;
    const extracted = (candidate as { extractedFields?: { chosen?: { title?: string | null; author?: string | null } } })
      .extractedFields?.chosen;
    const titleHint = candidate.evidence?.perFieldHints?.titleHints?.[0];
    const authorHint = candidate.evidence?.perFieldHints?.authorHints?.[0];

    return {
      title: edit?.title ?? extracted?.title ?? titleHint ?? null,
      author: edit?.author ?? extracted?.author ?? authorHint ?? null,
      isEdited: !!(edit?.title || edit?.author),
      editIndex,
    };
  }, [getCandidateEditIndex, userEdits]);

  const renderBookCandidate = useCallback(({ item }: { item: BookCandidateListItem }) => {
    const display = getCandidateDisplay(item);
    return (
      <BookCandidateCard
        candidate={item}
        onPress={() => setBookDetailCandidate(item)}
        title={display.title}
        author={display.author}
        isEdited={display.isEdited}
      />
    );
  }, [getCandidateDisplay]);

  const bookCandidateKeyExtractor = useCallback((item: BookCandidateListItem) => item.candidateId, []);

  const hasBookCandidates = bookCandidates.length > 0;

  const resolverDebugCounts = useMemo(() => {
    const counts = {
      total: bookCandidates.length,
      accept: 0,
      suggested: 0,
      reject: 0, // Everything that's not accept or suggested
      hypothesesZero: 0,
      pending: 0,
      other: 0,
    };
    const decisionTypes = new Set<string>();
    for (const candidate of bookCandidates) {
      const decision = candidate.resolverDecision;
      decisionTypes.add(decision || 'undefined');

      // Accept = only 'accept'
      if (decision === 'accept') {
        counts.accept += 1;
      }
      // Suggested = only 'suggested'
      else if (decision === 'suggested') {
        counts.suggested += 1;
      }
      // Reject = everything else (reject, pending, error, disabled, offline, undefined)
      else {
        counts.reject += 1;
      }
      const hypothesisCount = candidate.hypothesis?.searchCandidates?.length ?? 0;
      if (hypothesisCount === 0) counts.hypothesesZero += 1;
    }
    // Log all unique decision types for debugging
    console.log('[ResultsScreen] Decision types found:', Array.from(decisionTypes).join(', '));
    console.log('[ResultsScreen] Counts:', JSON.stringify(counts));
    return counts;
  }, [bookCandidates]);

  const bookListHeader = useMemo(() => {
    if (!hasBookCandidates && !showDiagnosticsUI) return null;

    const filterButtons: { key: StatusFilter; label: string; count: number; dotColor?: string }[] = [
      { key: 'all', label: 'All', count: resolverDebugCounts.total },
      { key: 'accept', label: 'Verified', count: resolverDebugCounts.accept, dotColor: colors.verified },
      { key: 'suggested', label: 'Suggested', count: resolverDebugCounts.suggested, dotColor: colors.primary },
      { key: 'reject', label: 'Unresolved', count: resolverDebugCounts.reject, dotColor: colors.rejected },
    ];

    return (
      <View style={styles.booksSummaryHeader}>
        {hasBookCandidates && bookCandidatesSummary && (
          <View style={styles.summaryRow}>
            <Text style={styles.booksSummaryText}>
              {bookCandidatesSummary.candidates} books found
            </Text>
            <Text style={styles.booksSummarySubtext}>
              from {bookCandidatesSummary.rawDetections} spine detections
            </Text>
          </View>
        )}
        {/* Status filter pills */}
        {hasBookCandidates && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.statusFilterScroll} contentContainerStyle={styles.statusFilterContainer}>
            {filterButtons.map((btn) => (
              <TouchableOpacity
                key={btn.key}
                style={[
                  styles.statusFilterButton,
                  statusFilter === btn.key && styles.statusFilterButtonActive,
                ]}
                onPress={() => setStatusFilter(btn.key)}
                activeOpacity={0.7}
              >
                {btn.dotColor && <View style={[styles.filterDot, { backgroundColor: btn.dotColor }]} />}
                <Text
                  style={[
                    styles.statusFilterButtonText,
                    statusFilter === btn.key && styles.statusFilterButtonTextActive,
                  ]}
                >
                  {btn.label}
                </Text>
                <Text style={[
                  styles.statusFilterCount,
                  statusFilter === btn.key && styles.statusFilterCountActive,
                ]}>
                  {btn.count}
                </Text>
              </TouchableOpacity>
            ))}
            {/* Export Rejects button */}
            {resolverDebugCounts.reject > 0 && showDiagnosticsUI && (
              <TouchableOpacity
                style={[styles.statusFilterButton, styles.exportButton]}
                onPress={handleExportRejects}
                activeOpacity={0.7}
              >
                <Text style={styles.statusFilterButtonText}>Export</Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        )}
        {showDiagnosticsUI && (
          <View style={styles.debugSummary}>
            <Text style={styles.debugSummaryText}>
              total: {resolverDebugCounts.total} | accept: {resolverDebugCounts.accept} | suggested: {resolverDebugCounts.suggested} | reject: {resolverDebugCounts.reject}
            </Text>
          </View>
        )}
      </View>
    );
  }, [bookCandidatesSummary, hasBookCandidates, showDiagnosticsUI, resolverDebugCounts, statusFilter, handleExportRejects]);

  const bookListFooter = useMemo(() => {
    if (!hasBookCandidates || !isMetadataResolutionEnabled()) return null;
    return (
      <MetadataResolutionCard
        resolution={metadataResolution}
        evidenceSummary={evidenceSummary}
        userSelectedBook={userSelectedBook}
        queuedForOffline={metadataQueuedForOffline}
        onSelectBook={handleSelectBook}
        onRetry={handleRetryMetadata}
        isRetrying={metadataRetrying}
      />
    );
  }, [
    metadataResolution,
    evidenceSummary,
    userSelectedBook,
    metadataQueuedForOffline,
    handleSelectBook,
    handleRetryMetadata,
    metadataRetrying,
    hasBookCandidates,
  ]);

  const bookListEmpty = useMemo(() => (
    <View style={styles.emptyState}>
      <View style={styles.emptyIconCircle}>
        <Text style={styles.emptyIcon}>{'📚'}</Text>
      </View>
      <Text style={styles.emptyTitle}>No Books Found</Text>
      <Text style={styles.emptyMessage}>
        {detections.length === 0
          ? 'No spines were detected in this scan. Try positioning the camera closer to the bookshelf.'
          : 'The pipeline is still processing. Book candidates will appear here shortly.'}
      </Text>
      {bookCandidatesSummary && (
        <View style={styles.emptyStatsPill}>
          <Text style={styles.emptyStatsText}>
            {bookCandidatesSummary.rawDetections} detections · {bookCandidatesSummary.rawCrops} crops
          </Text>
        </View>
      )}
    </View>
  ), [bookCandidatesSummary, detections.length]);

  const handleCloseBookDetail = useCallback(() => {
    setBookDetailCandidate(null);
  }, []);

  // Handle accepting a book match (persists to books_catalog and updates candidate status)
  const handleAcceptBook = useCallback(async () => {
    if (!bookDetailCandidate || !bookDetailCandidate.resolvedBook) {
      console.warn('[ResultsScreen] Cannot accept: no candidate or resolved book');
      return;
    }

    setIsAcceptingBook(true);
    console.log('[ResultsScreen] Accepting book:', bookDetailCandidate.resolvedBook.title);

    try {
      // Persist to books_catalog
      const result = await confirmUserSelection(bookDetailCandidate.resolvedBook, bookDetailCandidate.id);
      console.log('[ResultsScreen] Accept result:', result);

      if (result.success) {
        // Update the candidate in the store with accepted status
        const currentCandidates = useAppStore.getState().sessionMeta?.bookCandidates || [];
        const updatedCandidates = currentCandidates.map((c) => {
          if (c.id === bookDetailCandidate.id) {
            return {
              ...c,
              resolverDecision: 'accept' as const,
              resolvedBook: result.updatedBook || c.resolvedBook,
            };
          }
          return c;
        });
        useAppStore.getState().setSessionMeta({ bookCandidates: updatedCandidates });

        // Update local state to reflect the change
        setBookDetailCandidate({
          ...bookDetailCandidate,
          resolverDecision: 'accept',
          resolvedBook: result.updatedBook || bookDetailCandidate.resolvedBook,
        });

        Alert.alert('Success', `Book accepted and cataloged!\nID: ${result.bookId?.slice(0, 12)}...`);
      } else {
        Alert.alert('Error', result.error || 'Failed to accept book');
      }
    } catch (e: any) {
      console.error('[ResultsScreen] Accept error:', e);
      Alert.alert('Error', e.message || 'Failed to accept book');
    } finally {
      setIsAcceptingBook(false);
    }
  }, [bookDetailCandidate]);

  // Handle selecting a specific candidate from the suggestions list
  const handleSelectCandidate = useCallback(async (candidateIndex: number) => {
    if (!bookDetailCandidate || !bookDetailCandidate.resolverSuggestions) {
      console.warn('[ResultsScreen] Cannot select: no candidate or suggestions');
      return;
    }

    const selectedBook = bookDetailCandidate.resolverSuggestions[candidateIndex];
    if (!selectedBook) {
      console.warn('[ResultsScreen] Invalid candidate index:', candidateIndex);
      return;
    }

    setIsAcceptingBook(true);
    console.log('[ResultsScreen] Selecting alternative candidate:', selectedBook.title);

    try {
      // Persist to books_catalog
      const result = await confirmUserSelection(selectedBook, bookDetailCandidate.id);
      console.log('[ResultsScreen] Select result:', result);

      if (result.success) {
        // Update the candidate in the store with accepted status and new resolved book
        const currentCandidates = useAppStore.getState().sessionMeta?.bookCandidates || [];
        const updatedCandidates = currentCandidates.map((c) => {
          if (c.id === bookDetailCandidate.id) {
            return {
              ...c,
              resolverDecision: 'accept' as const,
              resolvedBook: result.updatedBook || selectedBook,
            };
          }
          return c;
        });
        useAppStore.getState().setSessionMeta({ bookCandidates: updatedCandidates });

        // Update local state to reflect the change
        setBookDetailCandidate({
          ...bookDetailCandidate,
          resolverDecision: 'accept',
          resolvedBook: result.updatedBook || selectedBook,
        });

        Alert.alert('Success', `Book selected and cataloged!\nID: ${result.bookId?.slice(0, 12)}...`);
      } else {
        Alert.alert('Error', result.error || 'Failed to select book');
      }
    } catch (e: any) {
      console.error('[ResultsScreen] Select error:', e);
      Alert.alert('Error', e.message || 'Failed to select book');
    } finally {
      setIsAcceptingBook(false);
    }
  }, [bookDetailCandidate]);

  const handleOpenCandidateEdit = useCallback((candidate: BookCandidateListItem) => {
    const display = getCandidateDisplay(candidate);
    setEditCandidateCropIndex(display.editIndex);
    setEditCandidateTitle(display.title || '');
    setEditCandidateAuthor(display.author || '');
    setEditingCandidate(candidate);
    setEditCandidateModalVisible(true);
  }, [getCandidateDisplay]);

  const handleCloseCandidateEdit = useCallback(() => {
    setEditCandidateModalVisible(false);
    setEditCandidateCropIndex(null);
    setEditCandidateTitle('');
    setEditCandidateAuthor('');
    setEditingCandidate(null);
  }, []);

  const handleSaveCandidateEdits = useCallback(() => {
    if (editCandidateCropIndex === null) {
      handleCloseCandidateEdit();
      return;
    }

    const currentMeta = useAppStore.getState().sessionMeta;
    if (!currentMeta) {
      handleCloseCandidateEdit();
      return;
    }

    const currentEdits = currentMeta.userEdits || {};
    useAppStore.getState().setSessionMeta({
      ...currentMeta,
      userEdits: {
        ...currentEdits,
        [editCandidateCropIndex]: {
          title: editCandidateTitle.trim() || undefined,
          author: editCandidateAuthor.trim() || undefined,
        },
      },
    });

    // Persist correction to corrections memory (Gate 10)
    if (editingCandidate) {
      const trimmedTitle = editCandidateTitle.trim() || null;
      const trimmedAuthor = editCandidateAuthor.trim() || null;
      saveCorrection(editingCandidate, trimmedTitle, trimmedAuthor);
    }

    handleCloseCandidateEdit();
  }, [editCandidateCropIndex, editCandidateTitle, editCandidateAuthor, editingCandidate, handleCloseCandidateEdit]);

  // Handler for reverting a correction
  const handleRevertCorrection = useCallback(() => {
    if (!editingCandidate || editCandidateCropIndex === null) {
      handleCloseCandidateEdit();
      return;
    }

    // Delete the stored correction
    deleteCorrection(editingCandidate);

    // Clear the user edit for this crop index
    const currentMeta = useAppStore.getState().sessionMeta;
    if (currentMeta) {
      const currentEdits = { ...currentMeta.userEdits };
      delete currentEdits[editCandidateCropIndex];
      useAppStore.getState().setSessionMeta({
        ...currentMeta,
        userEdits: currentEdits,
      });
    }

    handleCloseCandidateEdit();
  }, [editingCandidate, editCandidateCropIndex, handleCloseCandidateEdit]);

  // Check if the current candidate has a stored correction that can be reverted
  const canRevertCorrection = useMemo(() => {
    if (!editingCandidate) return false;
    return hasStoredCorrection(editingCandidate) || hasAppliedCorrection(editingCandidate);
  }, [editingCandidate]);

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingTitle}>Loading Results</Text>
        <Text style={styles.loadingSubtext}>Preparing your scan data...</Text>
      </View>
    );
  }

  // Safe empty state when no image dimensions available
  const canRenderOverlay = screenMapping && imageDimensions;

  return (
    <View style={styles.container}>
      {/* Error banner */}
      {loadError && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{loadError}</Text>
        </View>
      )}

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backButton} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={styles.backButtonText}>{'\u2039'}</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Results</Text>
          {bookCandidates.length > 0 && (
            <View style={styles.headerStats}>
              {resolverDebugCounts.accept > 0 && (
                <View style={[styles.headerStatPill, { backgroundColor: 'rgba(126, 200, 126, 0.12)' }]}>
                  <View style={[styles.headerStatDot, { backgroundColor: colors.verified }]} />
                  <Text style={[styles.headerStatText, { color: colors.verified }]}>{resolverDebugCounts.accept}</Text>
                </View>
              )}
              {resolverDebugCounts.suggested > 0 && (
                <View style={[styles.headerStatPill, { backgroundColor: colors.primaryMuted }]}>
                  <View style={[styles.headerStatDot, { backgroundColor: colors.primary }]} />
                  <Text style={[styles.headerStatText, { color: colors.primary }]}>{resolverDebugCounts.suggested}</Text>
                </View>
              )}
              {resolverDebugCounts.reject > 0 && (
                <View style={[styles.headerStatPill, { backgroundColor: 'rgba(199, 92, 92, 0.12)' }]}>
                  <View style={[styles.headerStatDot, { backgroundColor: colors.rejected }]} />
                  <Text style={[styles.headerStatText, { color: colors.rejected }]}>{resolverDebugCounts.reject}</Text>
                </View>
              )}
            </View>
          )}
        </View>
        <View style={styles.detectionCountContainer}>
          <Text style={styles.detectionCount}>{detections.length}</Text>
          <Text style={styles.detectionCountLabel}>spines</Text>
        </View>
      </View>

      {/* Spine Preview - Always visible compact view of detected spines */}
      {imageUri && detections.length > 0 && (
        <View style={styles.spinePreviewContainer} onLayout={handleContainerLayout}>
          <Image
            source={{ uri: imageUri }}
            style={styles.spinePreviewImage}
            resizeMode="contain"
          />
          {/* SVG Overlay showing detected spines */}
          {canRenderOverlay && (
            <Svg style={StyleSheet.absoluteFill}>
              {detections.map((detection, index) => {
                const center = getScreenCenter(detection);
                return (
                  <React.Fragment key={index}>
                    <Polygon
                      points={getPolygonPoints(detection, index)}
                      fill="rgba(212, 168, 83, 0.20)"
                      stroke={colors.primary}
                      strokeWidth={2}
                    />
                    <SvgText
                      x={center.x}
                      y={center.y}
                      fill={colors.primary}
                      fontSize={10}
                      fontWeight="bold"
                      textAnchor="middle"
                    >
                      {index + 1}
                    </SvgText>
                  </React.Fragment>
                );
              })}
            </Svg>
          )}
        </View>
      )}

      {/* Primary view selector */}
      <View style={styles.primaryBar}>
        <TouchableOpacity
          style={[styles.primaryTab, activeTab === 'books' && styles.primaryTabActive]}
          onPress={() => setActiveTab('books')}
          activeOpacity={0.7}
        >
          <Text style={[styles.primaryTabText, activeTab === 'books' && styles.primaryTabTextActive]}>
            Books
          </Text>
          {bookCandidates.length > 0 && (
            <View style={[styles.primaryTabBadge, activeTab === 'books' && styles.primaryTabBadgeActive]}>
              <Text style={[styles.primaryTabBadgeText, activeTab === 'books' && styles.primaryTabBadgeTextActive]}>
                {bookCandidates.length}
              </Text>
            </View>
          )}
        </TouchableOpacity>
        {showDiagnosticsUI && (
          <TouchableOpacity
            style={[styles.diagnosticsToggle, diagnosticsVisible && styles.diagnosticsToggleActive]}
            onPress={() => {
              navigation.navigate('Diagnostics', { sessionId });
            }}
            onLongPress={() => {
              setDiagnosticsVisible((prev) => {
                const next = !prev;
                if (!next) {
                  setActiveTab('books');
                } else if (activeTab === 'books') {
                  setActiveTab('overlay');
                }
                return next;
              });
            }}
            activeOpacity={0.7}
          >
            <Text style={[styles.diagnosticsToggleText, diagnosticsVisible && styles.diagnosticsToggleTextActive]}>
              Diagnostics
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {showDiagnosticsUI && diagnosticsVisible && (
        <View style={styles.tabBar}>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'overlay' && styles.tabActive]}
            onPress={() => setActiveTab('overlay')}
          >
            <Text style={[styles.tabText, activeTab === 'overlay' && styles.tabTextActive]}>
              Overlay
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'crops' && styles.tabActive]}
            onPress={() => setActiveTab('crops')}
          >
            <Text style={[styles.tabText, activeTab === 'crops' && styles.tabTextActive]}>
              Crops {hasSuccessfulCrops && `(${rectificationSummary?.succeeded || rectificationResults.filter(r => r.cropUri).length})`}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* OVERLAY VIEW - Image with detection overlay */}
      {showDiagnosticsUI && diagnosticsVisible && activeTab === 'overlay' && (
        <View style={styles.imageContainer} onLayout={handleContainerLayout}>
          {imageUri && (
            <Image
              source={{ uri: imageUri }}
              style={styles.image}
              resizeMode="contain"
            />
          )}

          {/* SVG Overlay - only render if we have valid mapping */}
          {canRenderOverlay && (
            <Svg style={StyleSheet.absoluteFill}>
              {detections.map((detection, index) => {
                const isSelected = selectedDetectionIndex === index;
                const center = getScreenCenter(detection);

                return (
                  <React.Fragment key={index}>
                    {/* OBB polygon */}
                    <Polygon
                      points={getPolygonPoints(detection, index)}
                      fill={isSelected ? 'rgba(212, 168, 83, 0.3)' : 'rgba(212, 168, 83, 0.15)'}
                      stroke={isSelected ? colors.primary : colors.primaryDim}
                      strokeWidth={isSelected ? 3 : 2}
                      onPress={() => handleDetectionTap(index)}
                    />

                    {/* Center point */}
                    <Circle
                      cx={center.x}
                      cy={center.y}
                      r={isSelected ? 6 : 4}
                      fill={isSelected ? colors.primary : colors.primaryDim}
                      onPress={() => handleDetectionTap(index)}
                    />

                    {/* Index label */}
                    <SvgText
                      x={center.x}
                      y={center.y - 12}
                      fill={isSelected ? colors.primary : colors.primaryDim}
                      fontSize={12}
                      fontWeight="bold"
                      textAnchor="middle"
                    >
                      {index + 1}
                    </SvgText>
                  </React.Fragment>
                );
              })}
            </Svg>
          )}
        </View>
      )}

      {/* CROPS VIEW - Grid of rectified crop images */}
      {showDiagnosticsUI && diagnosticsVisible && activeTab === 'crops' && (
        <View style={styles.cropsContainer}>
          {!effectiveHasSuccessfulCrops ? (
            // No crops available message
            <View style={styles.noCropsContainer}>
              <Text style={styles.noCropsTitle}>Rectification Unavailable</Text>
              <Text style={styles.noCropsMessage}>
                {Platform.OS === 'android'
                  ? 'Native rectification is not yet implemented on Android. Crops will be available in a future update.'
                  : 'No crops were generated for this session. This may be due to a processing error.'}
              </Text>
              {rectificationSummary && (
                <Text style={styles.noCropsStats}>
                  {rectificationSummary.total} detection{rectificationSummary.total !== 1 ? 's' : ''}, {rectificationSummary.skipped} skipped
                </Text>
              )}
            </View>
          ) : (
            // Crops grid
            <ScrollView contentContainerStyle={styles.cropsScrollContent}>
              {/* Share all button */}
              <TouchableOpacity style={styles.shareAllButton} onPress={handleShareAllCrops}>
                <Text style={styles.shareAllButtonText}>Share Crops</Text>
              </TouchableOpacity>

              {/* Crops grid */}
              <View style={styles.cropsGrid}>
                {effectiveRectResults.map((cropInfo, index) => {
                  const isSelected = selectedCropIndex === index;
                  const hasCrop = cropInfo.cropUri && cropInfo.rectificationMethod !== 'skipped';
                  const ocrResult = ocrResults[index];
                  const displayText = getDisplayText(index);
                  const isOcrProcessing = ocrProcessing === index;
                  const hasOcr = ocrResult?.ok;
                  const needsOcr = hasCrop && !hasOcr && ocrAvailable;
                  const hasError = !!imageLoadErrors[index];

                  // Calculate rotation for display (from OCR or auto-detect wide crops)
                  const ocrRotation = getCropRotation(index);
                  const cropW = cropInfo.cropWidth || 1;
                  const cropH = cropInfo.cropHeight || 1;
                  const autoRotate = isVeryWideCrop(cropW, cropH) && ocrRotation === 0;
                  const displayRotation = autoRotate ? 90 : ocrRotation;

                  // Calculate aspect ratio for proper sizing
                  const aspectRatio = cropW / cropH;
                  // If rotated 90 or 270, swap aspect ratio for layout
                  const layoutRotated = displayRotation === 90 || displayRotation === 270;
                  const displayAspectRatio = layoutRotated ? (1 / aspectRatio) : aspectRatio;

                  return (
                    <View key={index} style={styles.cropCardContainer}>
                      <TouchableOpacity
                        style={[
                          styles.cropCard,
                          isSelected && styles.cropCardSelected,
                          !hasCrop && styles.cropCardSkipped,
                        ]}
                        onPress={() => hasCrop && handleOpenPreview(index)}
                        onLongPress={() => hasCrop && handleShareCrop(cropInfo)}
                        disabled={!hasCrop}
                      >
                        {hasCrop ? (
                          hasError ? (
                            // Error fallback UI
                            <View style={styles.cropErrorContent}>
                              <Text style={styles.cropErrorIndex}>{index + 1}</Text>
                              <Text style={styles.cropErrorText}>Image load failed</Text>
                              <Text style={styles.cropErrorFilename}>
                                {getFilename(cropInfo.cropUri)}
                              </Text>
                            </View>
                          ) : (
                            <>
                              {/* Crop image with rotation */}
                              <View style={styles.cropImageContainer}>
                                <Image
                                  source={{ uri: ensureFileUri(cropInfo.cropUri) }}
                                  style={[
                                    styles.cropImage,
                                    displayRotation !== 0 && {
                                      transform: [{ rotate: `${displayRotation}deg` }],
                                    },
                                  ]}
                                  resizeMode="contain"
                                  onError={(e) => handleCropImageError(index, cropInfo.cropUri, e)}
                                />
                              </View>
                              <View style={styles.cropOverlay}>
                                <Text style={styles.cropIndex}>{index + 1}</Text>
                              </View>
                              {/* Rotation indicator */}
                              {displayRotation !== 0 && (
                                <View style={styles.rotationBadge}>
                                  <Text style={styles.rotationBadgeText}>{displayRotation}°</Text>
                                </View>
                              )}
                              {/* OCR confidence badge */}
                              {hasOcr && (
                                <View style={styles.ocrBadge}>
                                  <Text style={styles.ocrBadgeText}>
                                    {Math.round(ocrResult.avgConfidence * 100)}%
                                  </Text>
                                </View>
                              )}
                              {/* Processing indicator */}
                              {isOcrProcessing && (
                                <View style={styles.ocrProcessingOverlay}>
                                  <ActivityIndicator size="small" color="#fff" />
                                </View>
                              )}
                              {isSelected && (
                                <TouchableOpacity
                                  style={styles.cropShareButton}
                                  onPress={() => handleShareCrop(cropInfo)}
                                >
                                  <Text style={styles.cropShareButtonText}>Share</Text>
                                </TouchableOpacity>
                              )}
                            </>
                          )
                        ) : (
                          <View style={styles.cropSkippedContent}>
                            <Text style={styles.cropSkippedIndex}>{index + 1}</Text>
                            <Text style={styles.cropSkippedText}>Skipped</Text>
                            {cropInfo.skippedReason && (
                              <Text style={styles.cropSkippedReason}>
                                {cropInfo.skippedReason.replace(/_/g, ' ')}
                              </Text>
                            )}
                          </View>
                        )}
                      </TouchableOpacity>

                      {/* OCR Results below crop */}
                      {hasCrop && !hasError && (
                        <View style={styles.ocrInfoContainer}>
                          {hasOcr ? (
                            <TouchableOpacity
                              style={styles.ocrTextContainer}
                              onPress={() => handleOpenEditModal(index)}
                            >
                              {displayText.title && (
                                <Text style={styles.ocrTitle} numberOfLines={2}>
                                  {displayText.title}
                                </Text>
                              )}
                              {displayText.author && (
                                <Text style={styles.ocrAuthor} numberOfLines={1}>
                                  {displayText.author}
                                </Text>
                              )}
                              {!displayText.title && !displayText.author && (
                                <Text style={styles.ocrNoText}>Tap to add title</Text>
                              )}
                              <Text style={styles.editHint}>Tap to edit</Text>
                            </TouchableOpacity>
                          ) : needsOcr ? (
                            <TouchableOpacity
                              style={styles.runOcrButton}
                              onPress={() => handleRunOCR(index)}
                              disabled={isOcrProcessing}
                            >
                              <Text style={styles.runOcrButtonText}>
                                {isOcrProcessing ? 'Processing...' : 'Run OCR'}
                              </Text>
                            </TouchableOpacity>
                          ) : !ocrAvailable ? (
                            <TouchableOpacity
                              style={styles.ocrTextContainer}
                              onPress={() => handleOpenEditModal(index)}
                            >
                              <Text style={styles.ocrNoText}>Tap to add title</Text>
                            </TouchableOpacity>
                          ) : null}
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>

              {/* Summary stats */}
              {(rectificationSummary || ocrSummary) && (
                <View style={styles.cropsSummary}>
                  {rectificationSummary && (
                    <Text style={styles.cropsSummaryText}>
                      {rectificationSummary.succeeded} of {rectificationSummary.total} crops generated
                      {rectificationSummary.skipped > 0 && ` (${rectificationSummary.skipped} skipped)`}
                    </Text>
                  )}
                  {ocrSummary && (
                    <Text style={styles.cropsSummaryText}>
                      OCR: {ocrSummary.succeeded} succeeded, {ocrSummary.withTitles} with titles
                      {ocrSummary.dominantRotation !== undefined && ` (rotation: ${ocrSummary.dominantRotation}°)`}
                    </Text>
                  )}
                </View>
              )}
            </ScrollView>
          )}
        </View>
      )}

      {/* BOOKS VIEW - Grouped book candidates (Gate 7) */}
      {activeTab === 'books' && (
        <View style={styles.booksContainer}>
          <FlatList
            data={filteredBookCandidates ?? []}
            keyExtractor={bookCandidateKeyExtractor}
            renderItem={renderBookCandidate}
            contentContainerStyle={styles.booksScrollContent}
            ListHeaderComponent={bookListHeader}
            ListFooterComponent={bookListFooter}
            ListEmptyComponent={bookListEmpty}
            showsVerticalScrollIndicator={false}
          />
        </View>
      )}

      {/* Detection info panel */}
      {selectedDetectionIndex !== null && detections[selectedDetectionIndex] && (
        <View style={styles.infoPanel}>
          <Text style={styles.infoPanelTitle}>
            Detection {selectedDetectionIndex + 1}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.infoRow}>
              <InfoItem label="Score" value={detections[selectedDetectionIndex].score.toFixed(3)} />
              <InfoItem label="Center" value={`(${detections[selectedDetectionIndex].cx.toFixed(0)}, ${detections[selectedDetectionIndex].cy.toFixed(0)})`} />
              <InfoItem label="Size" value={`${detections[selectedDetectionIndex].width.toFixed(0)} x ${detections[selectedDetectionIndex].height.toFixed(0)}`} />
              <InfoItem label="Angle" value={`${(detections[selectedDetectionIndex].angle * 180 / Math.PI).toFixed(1)}°`} />
              <InfoItem label="Class" value={detections[selectedDetectionIndex].className || `ID: ${detections[selectedDetectionIndex].classId}`} />
            </View>
          </ScrollView>
        </View>
      )}

      {/* Detection list */}
      <View style={styles.listContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {detections.map((detection, index) => (
            <TouchableOpacity
              key={index}
              style={[
                styles.detectionChip,
                selectedDetectionIndex === index && styles.detectionChipSelected,
              ]}
              onPress={() => handleDetectionTap(index)}
            >
              <Text style={[
                styles.detectionChipText,
                selectedDetectionIndex === index && styles.detectionChipTextSelected,
              ]}>
                {index + 1}: {detection.score.toFixed(2)}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Edit Modal */}
      <Modal
        visible={editModalVisible}
        animationType="slide"
        transparent={true}
        onRequestClose={handleCloseEditModal}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={handleCloseEditModal} />
          <View style={styles.modalContent}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Edit Book Info</Text>
              <TouchableOpacity onPress={handleCloseEditModal} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Text style={styles.modalCloseText}>Cancel</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.modalInputContainer}>
              <Text style={styles.modalInputLabel}>TITLE</Text>
              <TextInput
                style={styles.modalInput}
                value={editTitle}
                onChangeText={setEditTitle}
                placeholder="Enter book title"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="words"
                autoCorrect={false}
                returnKeyType="next"
              />
            </View>

            <View style={styles.modalInputContainer}>
              <Text style={styles.modalInputLabel}>AUTHOR</Text>
              <TextInput
                style={styles.modalInput}
                value={editAuthor}
                onChangeText={setEditAuthor}
                placeholder="Enter author name"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="words"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={handleSaveEdits}
              />
            </View>

            <TouchableOpacity style={styles.modalSaveButton} onPress={handleSaveEdits} activeOpacity={0.8}>
              <Text style={styles.modalSaveButtonText}>Save Changes</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Full-screen Crop Preview Modal (TASK D) */}
      <Modal
        visible={previewModalVisible}
        animationType="fade"
        transparent={false}
        onRequestClose={handleClosePreview}
      >
        <View style={styles.previewModalContainer}>
          {/* Header with close and share buttons */}
          <View style={styles.previewHeader}>
            <TouchableOpacity onPress={handleClosePreview} style={styles.previewCloseButton}>
              <Text style={styles.previewCloseText}>Close</Text>
            </TouchableOpacity>
            <Text style={styles.previewHeaderTitle}>
              Crop {previewCropIndex !== null ? previewCropIndex + 1 : ''}
            </Text>
            {previewCropIndex !== null && effectiveRectResults[previewCropIndex]?.cropUri && (
              <TouchableOpacity
                onPress={() => handleShareCrop(effectiveRectResults[previewCropIndex])}
                style={styles.previewShareButton}
              >
                <Text style={styles.previewShareText}>Share</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Crop image preview */}
          {previewCropIndex !== null && effectiveRectResults[previewCropIndex]?.cropUri && (
            <View style={styles.previewImageContainer}>
              {(() => {
                const cropInfo = effectiveRectResults[previewCropIndex];
                const ocrRotation = getCropRotation(previewCropIndex);
                const cropW = cropInfo.cropWidth || 1;
                const cropH = cropInfo.cropHeight || 1;
                const autoRotate = isVeryWideCrop(cropW, cropH) && ocrRotation === 0;
                const displayRotation = autoRotate ? 90 : ocrRotation;

                return (
                  <Image
                    source={{ uri: ensureFileUri(cropInfo.cropUri) }}
                    style={[
                      styles.previewImage,
                      displayRotation !== 0 && {
                        transform: [{ rotate: `${displayRotation}deg` }],
                      },
                    ]}
                    resizeMode="contain"
                  />
                );
              })()}
            </View>
          )}

          {/* OCR info panel */}
          {previewCropIndex !== null && (
            <View style={styles.previewInfoPanel}>
              {(() => {
                const ocrResult = ocrResults[previewCropIndex];
                const displayText = getDisplayText(previewCropIndex);
                const hasOcr = ocrResult?.ok;

                return (
                  <>
                    {displayText.title && (
                      <Text style={styles.previewTitle} numberOfLines={3}>
                        {displayText.title}
                      </Text>
                    )}
                    {displayText.author && (
                      <Text style={styles.previewAuthor} numberOfLines={2}>
                        by {displayText.author}
                      </Text>
                    )}
                    {hasOcr && (
                      <View style={styles.previewOcrStats}>
                        <Text style={styles.previewOcrStatsText}>
                          OCR Confidence: {Math.round(ocrResult.avgConfidence * 100)}%
                        </Text>
                        {ocrResult.chosenRotation !== 0 && (
                          <Text style={styles.previewOcrStatsText}>
                            Rotation: {ocrResult.chosenRotation}°
                          </Text>
                        )}
                      </View>
                    )}
                    {!displayText.title && !displayText.author && (
                      <Text style={styles.previewNoText}>
                        No text extracted. Tap Edit below to add manually.
                      </Text>
                    )}
                    {/* Edit button */}
                    <TouchableOpacity
                      style={styles.previewEditButton}
                      onPress={() => {
                        handleClosePreview();
                        setTimeout(() => handleOpenEditModal(previewCropIndex), 300);
                      }}
                    >
                      <Text style={styles.previewEditButtonText}>Edit Title / Author</Text>
                    </TouchableOpacity>
                  </>
                );
              })()}
            </View>
          )}
        </View>
      </Modal>

      <BookCandidateDetailModal
        visible={!!bookDetailCandidate}
        candidate={bookDetailCandidate}
        onClose={handleCloseBookDetail}
        onEdit={
          bookDetailCandidate
            ? () => {
              handleCloseBookDetail();
              handleOpenCandidateEdit(bookDetailCandidate);
            }
            : undefined
        }
        canEdit={
          bookDetailCandidate
            ? getCandidateDisplay(bookDetailCandidate).editIndex !== null
            : false
        }
        isEdited={
          bookDetailCandidate
            ? getCandidateDisplay(bookDetailCandidate).isEdited
            : false
        }
        onAccept={
          bookDetailCandidate?.resolvedBook && bookDetailCandidate.resolverDecision !== 'accept'
            ? handleAcceptBook
            : undefined
        }
        onSelectCandidate={
          bookDetailCandidate?.resolverDecision === 'suggested' &&
          bookDetailCandidate?.resolverSuggestions?.length
            ? handleSelectCandidate
            : undefined
        }
        isAccepting={isAcceptingBook}
      />

      <EditCandidateFieldsModal
        visible={editCandidateModalVisible}
        title={editCandidateTitle}
        author={editCandidateAuthor}
        onChangeTitle={setEditCandidateTitle}
        onChangeAuthor={setEditCandidateAuthor}
        onSave={handleSaveCandidateEdits}
        onCancel={handleCloseCandidateEdit}
        onRevert={handleRevertCorrection}
        canSave={editCandidateCropIndex !== null}
        canRevert={canRevertCorrection}
      />
    </View>
  );
}

// Info item component
function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoItem}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

// Metadata Resolution Card component (Gate 8+)
interface MetadataResolutionCardProps {
  resolution: SessionMeta['metadataResolution'];
  evidenceSummary: SessionMeta['evidenceSummary'];
  userSelectedBook: ResolvedBook | null;
  queuedForOffline?: boolean;
  onSelectBook: (book: ResolvedBook) => void;
  onRetry: () => void;
  isRetrying: boolean;
}

function MetadataResolutionCard({
  resolution,
  evidenceSummary,
  userSelectedBook,
  queuedForOffline,
  onSelectBook,
  onRetry,
  isRetrying,
}: MetadataResolutionCardProps) {
  // No resolution yet
  if (!resolution) {
    return (
      <View style={styles.metadataCard}>
        <Text style={styles.metadataCardTitle}>Metadata Resolution</Text>
        <Text style={styles.metadataNoData}>
          Resolution not yet run. Tap retry to attempt metadata lookup.
        </Text>
        <TouchableOpacity
          style={[styles.metadataRetryButton, isRetrying && styles.metadataRetryButtonDisabled]}
          onPress={onRetry}
          disabled={isRetrying}
        >
          <Text style={styles.metadataRetryButtonText}>
            {isRetrying ? 'Resolving...' : 'Resolve Metadata'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  const decision = resolution.decision;
  const displayBook = userSelectedBook || resolution.resolvedBook;

  // Get action display info
  const getActionInfo = (action: AcceptanceDecision['action']) => {
    switch (action) {
      // New action types
      case 'accept_high':
        return { label: 'Accepted (High)', color: colors.verified, icon: '✓' };
      case 'accept_medium':
        return { label: 'Accepted', color: colors.verified, icon: '✓' };
      case 'suggested':
        return { label: 'Suggested', color: colors.suggested, icon: '~' };
      case 'reject':
        return { label: 'No Match', color: colors.textSecondary, icon: '✗' };
      // Legacy action types (backwards compatibility)
      case 'auto-accept':
        return { label: 'Matched', color: colors.verified, icon: '✓' };
      case 'suggest':
        return { label: 'Suggested', color: colors.suggested, icon: '?' };
      case 'ambiguous':
        return { label: 'Ambiguous', color: colors.rejected, icon: '!' };
      case 'no-match':
        return { label: 'No Match', color: colors.textSecondary, icon: '—' };
      default:
        return { label: 'Unknown', color: colors.textSecondary, icon: '?' };
    }
  };

  const actionInfo = getActionInfo(decision.action);

  // Get verification flag display
  const getFlagDisplay = (flag: VerificationFlag) => {
    switch (flag) {
      case 'author-mismatch':
        return 'Author mismatch';
      case 'isbn-mismatch':
        return 'ISBN mismatch';
      case 'token-coverage-low':
        return 'Low text match';
      case 'suspicious-edition':
        return 'Suspicious edition';
      case 'year-implausible':
        return 'Invalid year';
      case 'publisher-mismatch':
        return 'Publisher mismatch';
      case 'edition-conflict':
        return 'Edition conflict';
      default:
        return flag;
    }
  };

  return (
    <View style={styles.metadataCard}>
      <View style={styles.metadataCardHeader}>
        <Text style={styles.metadataCardTitle}>Metadata Resolution</Text>
        <View style={[styles.metadataStatusBadge, { backgroundColor: actionInfo.color }]}>
          <Text style={styles.metadataStatusText}>{actionInfo.label}</Text>
        </View>
      </View>

      {/* Evidence tier */}
      {evidenceSummary && (
        <View style={styles.metadataEvidenceRow}>
          <Text style={styles.metadataLabel}>Evidence Quality:</Text>
          <Text style={[
            styles.metadataEvidenceTier,
            evidenceSummary.sessionTier === 'strong' && { color: colors.verified },
            evidenceSummary.sessionTier === 'usable' && { color: colors.suggested },
            evidenceSummary.sessionTier === 'weak' && { color: colors.rejected },
          ]}>
            {evidenceSummary.sessionTier.charAt(0).toUpperCase() + evidenceSummary.sessionTier.slice(1)}
          </Text>
        </View>
      )}

      {/* Queued for offline indicator */}
      {queuedForOffline && (
        <View style={styles.metadataOfflineBadge}>
          <Text style={styles.metadataOfflineText}>Queued for retry when online</Text>
        </View>
      )}

      {/* Display resolved/selected book */}
      {displayBook && (
        <View style={styles.metadataBookInfo}>
          <Text style={styles.metadataBookTitle}>{displayBook.title}</Text>
          {displayBook.authors && displayBook.authors.length > 0 && (
            <Text style={styles.metadataBookAuthor}>
              by {displayBook.authors.join(', ')}
            </Text>
          )}
          {displayBook.publisher && (
            <Text style={styles.metadataBookMeta}>{displayBook.publisher}</Text>
          )}
          {displayBook.edition && (
            <Text style={styles.metadataBookMeta}>{displayBook.edition}</Text>
          )}
          {displayBook.publishYear && (
            <Text style={styles.metadataBookMeta}>{displayBook.publishYear}</Text>
          )}
          {displayBook.isbn13 && (
            <Text style={styles.metadataBookIsbn}>ISBN: {displayBook.isbn13}</Text>
          )}
          {'confidence' in decision && (
            <Text style={styles.metadataConfidence}>
              Confidence: {Math.round(decision.confidence * 100)}%
            </Text>
          )}
        </View>
      )}

      {/* Warnings/flags */}
      {resolution.verificationFlags && resolution.verificationFlags.length > 0 && (
        <View style={styles.metadataWarnings}>
          <Text style={styles.metadataWarningsLabel}>Warnings:</Text>
          {resolution.verificationFlags.map((flag, idx) => (
            <View key={idx} style={styles.metadataWarningBadge}>
              <Text style={styles.metadataWarningText}>{getFlagDisplay(flag)}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Alternatives for suggested/suggest/ambiguous */}
      {(decision.action === 'suggested' || decision.action === 'suggest' || decision.action === 'ambiguous') && (
        <View style={styles.metadataAlternatives}>
          <Text style={styles.metadataAlternativesLabel}>
            {decision.action === 'ambiguous' ? 'Candidates:' : 'Alternatives (optional review):'}
          </Text>
          {(decision.action === 'suggested' ? decision.alternatives : decision.action === 'suggest' ? decision.alternatives : decision.candidates).map((book, idx) => (
            <TouchableOpacity
              key={idx}
              style={[
                styles.metadataAlternativeItem,
                userSelectedBook?.title === book.title && styles.metadataAlternativeSelected,
              ]}
              onPress={() => onSelectBook(book)}
            >
              <Text style={styles.metadataAlternativeTitle} numberOfLines={1}>
                {book.title}
              </Text>
              {book.authors && book.authors.length > 0 && (
                <Text style={styles.metadataAlternativeAuthor} numberOfLines={1}>
                  {book.authors.join(', ')}
                </Text>
              )}
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* No match / reject info */}
      {(decision.action === 'no-match' || decision.action === 'reject') && (
        <View style={styles.metadataNoMatch}>
          <Text style={styles.metadataNoMatchText}>
            {decision.action === 'reject'
              ? `No match found: ${'reason' in decision ? decision.reason : 'Score too low'}`
              : decision.fallback === 'ocr-only'
                ? 'Using OCR-extracted text. Edit title/author manually if needed.'
                : 'No metadata found. Enter book details manually.'}
          </Text>
        </View>
      )}

      {/* Retry button */}
      <TouchableOpacity
        style={[styles.metadataRetryButton, isRetrying && styles.metadataRetryButtonDisabled]}
        onPress={onRetry}
        disabled={isRetrying}
      >
        {isRetrying ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={styles.metadataRetryButtonText}>Retry Resolution</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgDeep,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.bgDeep,
  },
  loadingTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontFamily: fonts.display.semiBold,
    marginTop: spacing.xl,
  },
  loadingSubtext: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: spacing.sm,
  },

  // Error
  errorBanner: {
    backgroundColor: 'rgba(199, 92, 92, 0.9)',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  errorText: {
    color: colors.textPrimary,
    fontSize: 13,
    textAlign: 'center',
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: 60,
    paddingBottom: spacing.md,
    backgroundColor: colors.bgElevated,
    borderBottomWidth: 1,
    borderBottomColor: colors.separator,
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bgNested,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    color: colors.primary,
    fontSize: 24,
    lineHeight: 28,
    marginTop: -2,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontFamily: fonts.display.semiBold,
  },
  headerStats: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 6,
  },
  headerStatPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.pill,
    gap: 4,
  },
  headerStatDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  headerStatText: {
    fontSize: 11,
    fontWeight: '700',
  },
  detectionCountContainer: {
    alignItems: 'center',
    backgroundColor: colors.bgNested,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  detectionCount: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '700',
  },
  detectionCountLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // Spine preview
  spinePreviewContainer: {
    height: 160,
    backgroundColor: colors.bgBase,
    marginHorizontal: spacing.md,
    marginVertical: spacing.sm,
    borderRadius: radii.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  spinePreviewImage: {
    flex: 1,
    width: '100%',
    height: '100%',
  },

  // Image container
  imageContainer: {
    flex: 1,
    backgroundColor: colors.bgDeep,
  },
  image: {
    flex: 1,
    width: '100%',
    height: '100%',
  },

  // Info panel
  infoPanel: {
    backgroundColor: colors.bgElevated,
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.separator,
  },
  infoPanelTitle: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: spacing.md,
  },
  infoRow: {
    flexDirection: 'row',
  },
  infoItem: {
    marginRight: spacing.xxl,
  },
  infoLabel: {
    color: colors.textTertiary,
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 3,
  },
  infoValue: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '500',
  },

  // Detection chips
  listContainer: {
    backgroundColor: colors.bgElevated,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.separator,
  },
  detectionChip: {
    backgroundColor: colors.bgNested,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radii.pill,
    marginRight: 8,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  detectionChipSelected: {
    backgroundColor: colors.primaryMuted,
    borderColor: colors.primary,
  },
  detectionChipText: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  detectionChipTextSelected: {
    color: colors.primary,
    fontWeight: '600',
  },

  // Tab bar
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.bgElevated,
    borderBottomWidth: 1,
    borderBottomColor: colors.separator,
  },
  primaryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.bgElevated,
    borderBottomWidth: 1,
    borderBottomColor: colors.separator,
    paddingHorizontal: spacing.lg,
  },
  primaryTab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: 6,
  },
  primaryTabActive: {
    borderBottomWidth: 2,
    borderBottomColor: colors.primary,
  },
  primaryTabText: {
    color: colors.textSecondary,
    fontSize: 15,
    fontWeight: '600',
  },
  primaryTabTextActive: {
    color: colors.primary,
  },
  primaryTabBadge: {
    backgroundColor: colors.bgNested,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radii.pill,
  },
  primaryTabBadgeActive: {
    backgroundColor: colors.primaryMuted,
  },
  primaryTabBadgeText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  primaryTabBadgeTextActive: {
    color: colors.primary,
  },
  diagnosticsToggle: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.bgNested,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  diagnosticsToggleActive: {
    backgroundColor: colors.primaryMuted,
    borderColor: colors.primary,
  },
  diagnosticsToggleText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
  },
  diagnosticsToggleTextActive: {
    color: colors.primary,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: colors.primary,
  },
  tabText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: '500',
  },
  tabTextActive: {
    color: colors.primary,
  },

  // Crops view
  cropsContainer: {
    flex: 1,
    backgroundColor: colors.bgDeep,
  },
  cropsScrollContent: {
    padding: spacing.lg,
  },
  noCropsContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xxxl,
  },
  noCropsTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontFamily: fonts.display.semiBold,
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  noCropsMessage: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: spacing.lg,
  },
  noCropsStats: {
    color: colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
  },
  shareAllButton: {
    backgroundColor: colors.primaryMuted,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: radii.pill,
    alignSelf: 'center',
    marginBottom: spacing.lg,
  },
  shareAllButtonText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  cropsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
  },
  cropCard: {
    width: '100%',
    height: 200,
    backgroundColor: colors.bgElevated,
    borderRadius: radii.lg,
    overflow: 'hidden',
    position: 'relative',
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  cropCardSelected: {
    borderWidth: 2,
    borderColor: colors.primary,
  },
  cropCardSkipped: {
    opacity: 0.4,
  },
  cropImage: {
    width: '100%',
    height: '100%',
  },
  cropOverlay: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(12, 10, 9, 0.75)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.sm,
  },
  cropIndex: {
    color: colors.textPrimary,
    fontSize: 11,
    fontWeight: '700',
  },
  cropShareButton: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: radii.sm,
  },
  cropShareButtonText: {
    color: colors.bgDeep,
    fontSize: 11,
    fontWeight: '700',
  },
  cropSkippedContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  cropSkippedIndex: {
    color: colors.textMuted,
    fontSize: 22,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  cropSkippedText: {
    color: colors.textTertiary,
    fontSize: 13,
    fontWeight: '500',
  },
  cropSkippedReason: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 4,
    textAlign: 'center',
  },
  cropsSummary: {
    paddingTop: spacing.md,
    alignItems: 'center',
  },
  cropsSummaryText: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: 3,
  },

  // OCR
  cropCardContainer: {
    marginRight: spacing.lg,
    marginBottom: spacing.lg,
    width: (SCREEN_WIDTH - 48) / 2,
  },
  ocrBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(126, 200, 126, 0.85)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.sm,
  },
  ocrBadgeText: {
    color: colors.bgDeep,
    fontSize: 10,
    fontWeight: '700',
  },
  ocrProcessingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(12, 10, 9, 0.65)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  ocrInfoContainer: {
    paddingTop: spacing.sm,
    paddingHorizontal: 4,
    minHeight: 44,
  },
  ocrTitle: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 16,
  },
  ocrAuthor: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  ocrNoText: {
    color: colors.textMuted,
    fontSize: 11,
    fontStyle: 'italic',
  },
  runOcrButton: {
    backgroundColor: colors.primaryMuted,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radii.sm,
    alignSelf: 'flex-start',
  },
  runOcrButtonText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '600',
  },
  ocrUnavailable: {
    color: colors.textMuted,
    fontSize: 11,
    fontStyle: 'italic',
  },
  ocrTextContainer: {
    flex: 1,
  },
  editHint: {
    color: colors.primary,
    fontSize: 10,
    marginTop: 4,
    fontWeight: '500',
  },

  // Modal
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(12, 10, 9, 0.5)',
  },
  modalContent: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radii.xxl,
    borderTopRightRadius: radii.xxl,
    paddingHorizontal: spacing.xxl,
    paddingBottom: Platform.OS === 'ios' ? 40 : spacing.xxl,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
  },
  modalHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.bgOverlay,
    alignSelf: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.lg,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xxl,
  },
  modalTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontFamily: fonts.display.semiBold,
  },
  modalCloseText: {
    color: colors.textSecondary,
    fontSize: 15,
  },
  modalInputContainer: {
    marginBottom: spacing.xl,
  },
  modalInputLabel: {
    color: colors.textTertiary,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  modalInput: {
    backgroundColor: colors.bgNested,
    borderRadius: radii.md,
    padding: spacing.lg,
    color: colors.textPrimary,
    fontSize: 16,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  modalSaveButton: {
    backgroundColor: colors.primary,
    borderRadius: radii.lg,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: spacing.sm,
    ...shadows.glowSubtle,
  },
  modalSaveButtonText: {
    color: colors.bgDeep,
    fontSize: 16,
    fontWeight: '700',
  },

  // Crop image rotation
  cropImageContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  rotationBadge: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    backgroundColor: 'rgba(139, 115, 64, 0.9)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.sm,
  },
  rotationBadgeText: {
    color: colors.textPrimary,
    fontSize: 10,
    fontWeight: '700',
  },

  // Crop error
  cropErrorContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.md,
    backgroundColor: colors.bgNested,
  },
  cropErrorIndex: {
    color: colors.rejected,
    fontSize: 22,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  cropErrorText: {
    color: colors.rejected,
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 4,
  },
  cropErrorFilename: {
    color: colors.textMuted,
    fontSize: 10,
    textAlign: 'center',
  },

  // Preview modal
  previewModalContainer: {
    flex: 1,
    backgroundColor: colors.bgDeep,
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: 60,
    paddingBottom: spacing.lg,
    backgroundColor: colors.bgElevated,
    borderBottomWidth: 1,
    borderBottomColor: colors.separator,
  },
  previewCloseButton: {
    padding: spacing.sm,
  },
  previewCloseText: {
    color: colors.primary,
    fontSize: 15,
  },
  previewHeaderTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontFamily: fonts.display.semiBold,
  },
  previewShareButton: {
    padding: spacing.sm,
  },
  previewShareText: {
    color: colors.primary,
    fontSize: 15,
  },
  previewImageContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.bgDeep,
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  previewInfoPanel: {
    backgroundColor: colors.bgElevated,
    padding: spacing.xxl,
    paddingBottom: Platform.OS === 'ios' ? 40 : spacing.xxl,
    borderTopWidth: 1,
    borderTopColor: colors.separator,
  },
  previewTitle: {
    color: colors.textPrimary,
    fontSize: 20,
    fontFamily: fonts.display.semiBold,
    marginBottom: spacing.sm,
  },
  previewAuthor: {
    color: colors.textSecondary,
    fontSize: 15,
    marginBottom: spacing.md,
  },
  previewOcrStats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: spacing.lg,
  },
  previewOcrStatsText: {
    color: colors.textMuted,
    fontSize: 12,
    marginRight: spacing.lg,
  },
  previewNoText: {
    color: colors.textMuted,
    fontSize: 14,
    fontStyle: 'italic',
    marginBottom: spacing.lg,
  },
  previewEditButton: {
    backgroundColor: colors.primaryMuted,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: radii.pill,
    alignSelf: 'flex-start',
  },
  previewEditButtonText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },

  // Books view
  booksContainer: {
    flex: 1,
    backgroundColor: colors.bgDeep,
  },
  booksScrollContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xxxxl,
  },

  // Book list header
  booksSummaryHeader: {
    marginBottom: spacing.lg,
  },
  summaryRow: {
    marginBottom: spacing.md,
  },
  booksSummaryText: {
    color: colors.textPrimary,
    fontSize: 16,
    fontFamily: fonts.display.semiBold,
  },
  booksSummarySubtext: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 3,
  },
  debugSummary: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.separator,
  },
  debugSummaryText: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  // Status filters
  statusFilterScroll: {
    flexGrow: 0,
  },
  statusFilterContainer: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 2,
  },
  statusFilterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radii.pill,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    gap: 5,
  },
  statusFilterButtonActive: {
    backgroundColor: colors.primaryMuted,
    borderColor: colors.primary,
  },
  filterDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusFilterButtonText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
  statusFilterButtonTextActive: {
    color: colors.primary,
    fontWeight: '600',
  },
  statusFilterCount: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  statusFilterCountActive: {
    color: colors.primary,
  },
  exportButton: {
    backgroundColor: colors.bgNested,
    borderColor: colors.glassBorder,
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xxxxl,
    paddingHorizontal: spacing.xxl,
  },
  emptyIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primaryMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
  },
  emptyIcon: {
    fontSize: 28,
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontFamily: fonts.display.semiBold,
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  emptyMessage: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: spacing.lg,
  },
  emptyStatsPill: {
    backgroundColor: colors.bgElevated,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  emptyStatsText: {
    color: colors.textMuted,
    fontSize: 12,
  },

  // Book cards (legacy - used by MetadataResolutionCard)
  bookCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.xl,
    marginBottom: spacing.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  bookCardHeader: {
    flexDirection: 'row',
    padding: spacing.md,
  },
  bookCardThumbnail: {
    width: 60,
    height: 80,
    borderRadius: radii.sm,
    backgroundColor: colors.bgNested,
    overflow: 'hidden',
  },
  bookThumbnailImage: {
    width: '100%',
    height: '100%',
  },
  bookThumbnailPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  bookThumbnailText: {
    color: colors.textMuted,
    fontSize: 20,
    fontWeight: '600',
  },
  bookCardInfo: {
    flex: 1,
    marginLeft: spacing.md,
  },
  bookCardIndex: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 3,
  },
  bookCardTitle: {
    color: colors.textPrimary,
    fontSize: 15,
    fontFamily: fonts.display.semiBold,
    lineHeight: 20,
  },
  bookCardNoTitle: {
    color: colors.textMuted,
    fontSize: 14,
    fontStyle: 'italic',
  },
  bookCardAuthor: {
    color: colors.textSecondary,
    fontSize: 13,
    marginTop: 2,
  },
  bookCardMeta: {
    marginTop: spacing.sm,
  },
  bookCardMetaText: {
    color: colors.textMuted,
    fontSize: 11,
  },
  bookEvidenceContainer: {
    padding: spacing.md,
    paddingTop: 0,
    borderTopWidth: 1,
    borderTopColor: colors.separator,
    marginTop: 4,
  },
  bookEvidenceLabel: {
    color: colors.textTertiary,
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
    marginTop: spacing.md,
  },
  bookEvidenceText: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  bookEvidenceCount: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: spacing.sm,
  },
  bookCropsStrip: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    marginTop: spacing.sm,
  },
  bookCropThumb: {
    width: 44,
    height: 60,
    borderRadius: radii.sm,
    marginRight: spacing.sm,
    backgroundColor: colors.bgNested,
  },

  // Metadata Resolution Card
  metadataCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.xl,
    padding: spacing.lg,
    marginTop: spacing.lg,
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  metadataCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  metadataCardTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontFamily: fonts.display.semiBold,
  },
  metadataStatusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.pill,
  },
  metadataStatusText: {
    color: colors.bgDeep,
    fontSize: 11,
    fontWeight: '700',
  },
  metadataNoData: {
    color: colors.textSecondary,
    fontSize: 14,
    marginBottom: spacing.lg,
    textAlign: 'center',
  },
  metadataLabel: {
    color: colors.textTertiary,
    fontSize: 12,
    fontWeight: '500',
  },
  metadataEvidenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  metadataEvidenceTier: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    marginLeft: spacing.sm,
  },
  metadataOfflineBadge: {
    backgroundColor: colors.primaryMuted,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.sm,
    marginBottom: spacing.md,
  },
  metadataOfflineText: {
    color: colors.primary,
    fontSize: 12,
    textAlign: 'center',
  },
  metadataBookInfo: {
    backgroundColor: colors.bgNested,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  metadataBookTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontFamily: fonts.display.semiBold,
    marginBottom: 4,
  },
  metadataBookAuthor: {
    color: colors.textSecondary,
    fontSize: 14,
    marginBottom: spacing.sm,
  },
  metadataBookMeta: {
    color: colors.textTertiary,
    fontSize: 12,
    marginBottom: 2,
  },
  metadataBookIsbn: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 6,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  metadataConfidence: {
    color: colors.verified,
    fontSize: 12,
    fontWeight: '600',
    marginTop: spacing.sm,
  },
  metadataWarnings: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    marginBottom: spacing.md,
    gap: 6,
  },
  metadataWarningsLabel: {
    color: colors.textTertiary,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  metadataWarningBadge: {
    backgroundColor: 'rgba(199, 92, 92, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.pill,
  },
  metadataWarningText: {
    color: colors.rejected,
    fontSize: 11,
    fontWeight: '500',
  },
  metadataAlternatives: {
    marginBottom: spacing.md,
  },
  metadataAlternativesLabel: {
    color: colors.textTertiary,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: spacing.sm,
  },
  metadataAlternativeItem: {
    backgroundColor: colors.bgNested,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  metadataAlternativeSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryMuted,
  },
  metadataAlternativeTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '500',
  },
  metadataAlternativeAuthor: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  metadataNoMatch: {
    backgroundColor: colors.bgNested,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  metadataNoMatchText: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  metadataRetryButton: {
    backgroundColor: colors.primary,
    paddingVertical: 12,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    ...shadows.glowSubtle,
  },
  metadataRetryButtonDisabled: {
    backgroundColor: colors.bgNested,
    shadowOpacity: 0,
  },
  metadataRetryButtonText: {
    color: colors.bgDeep,
    fontSize: 15,
    fontWeight: '700',
  },
});

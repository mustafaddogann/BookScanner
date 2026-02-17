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
import { useNavigation, useRoute, useIsFocused, RouteProp } from '@react-navigation/native';
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
  getServerUrl,
} from '../services/autoExportService';

// Tab options for switching between overlay, crops, and books views
type ResultsTab = 'overlay' | 'crops' | 'books';

type BookCandidateListItem = BookCandidate & { candidateId: string };

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Results'>;
type ResultsRouteProp = RouteProp<RootStackParamList, 'Results'>;

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export function ResultsScreen(): React.JSX.Element {
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<ResultsRouteProp>();
  const isFocused = useIsFocused();
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
    if (!isFocused || !autoRetryEnabled || metadataRetrying) return;

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
  }, [isFocused, autoRetryEnabled, autoRetryInterval, metadataRetrying, sessionId, setAutoRetryEnabled]);

  // Auto-rescan polling: Check server for rebuild signals
  // When code changes are deployed, server signals the app to rescan
  useEffect(() => {
    if (!isFocused || !autoRetryEnabled) return;

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
  }, [isFocused, autoRetryEnabled, navigation]);

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

    const filterButtons: { key: StatusFilter; label: string; count: number }[] = [
      { key: 'all', label: 'All', count: resolverDebugCounts.total },
      { key: 'reject', label: 'Reject', count: resolverDebugCounts.reject },
      { key: 'suggested', label: 'Suggested', count: resolverDebugCounts.suggested },
      { key: 'accept', label: 'Accept', count: resolverDebugCounts.accept },
    ];

    return (
      <View style={styles.booksSummaryHeader}>
        {hasBookCandidates && bookCandidatesSummary && (
          <>
            <Text style={styles.booksSummaryText}>
              {bookCandidatesSummary.candidates} books from {bookCandidatesSummary.rawDetections} detections
            </Text>
            <Text style={styles.booksSummarySubtext}>
              Avg {bookCandidatesSummary.avgCropsPerCandidate} crops per book
            </Text>
          </>
        )}
        {/* Status filter buttons */}
        {hasBookCandidates && (
          <View style={styles.statusFilterContainer}>
            {filterButtons.map((btn) => (
              <TouchableOpacity
                key={btn.key}
                style={[
                  styles.statusFilterButton,
                  statusFilter === btn.key && styles.statusFilterButtonActive,
                  btn.key === 'reject' && statusFilter === btn.key && styles.statusFilterButtonReject,
                ]}
                onPress={() => setStatusFilter(btn.key)}
              >
                <Text
                  style={[
                    styles.statusFilterButtonText,
                    statusFilter === btn.key && styles.statusFilterButtonTextActive,
                  ]}
                >
                  {btn.label} ({btn.count})
                </Text>
              </TouchableOpacity>
            ))}
            {/* Export Rejects button */}
            {resolverDebugCounts.reject > 0 && (
              <TouchableOpacity
                style={[styles.statusFilterButton, styles.exportButton]}
                onPress={handleExportRejects}
              >
                <Text style={styles.statusFilterButtonText}>Export</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        {showDiagnosticsUI && (
          <View style={styles.debugSummary}>
            <Text style={styles.debugSummaryText}>
              candidates_total: {resolverDebugCounts.total}
            </Text>
            <Text style={styles.debugSummaryText}>
              resolved_accept: {resolverDebugCounts.accept}
            </Text>
            <Text style={styles.debugSummaryText}>
              resolved_suggested: {resolverDebugCounts.suggested}
            </Text>
            <Text style={styles.debugSummaryText}>
              resolved_reject: {resolverDebugCounts.reject}
            </Text>
            <Text style={styles.debugSummaryText}>
              hypotheses_zero_count: {resolverDebugCounts.hypothesesZero}
            </Text>
          </View>
        )}
      </View>
    );
  }, [bookCandidatesSummary, hasBookCandidates, showDiagnosticsUI, resolverDebugCounts, statusFilter]);

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
    <View style={styles.noCropsContainer}>
      <Text style={styles.noCropsTitle}>No Book Candidates</Text>
      <Text style={styles.noCropsMessage}>
        {detections.length === 0
          ? 'No detections were found in this scan.'
          : 'Book candidates will appear here after the pipeline groups detections.'}
      </Text>
      {bookCandidatesSummary && (
        <Text style={styles.noCropsStats}>
          {bookCandidatesSummary.rawDetections} detections, {bookCandidatesSummary.rawCrops} crops
        </Text>
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
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading results...</Text>
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
        <TouchableOpacity onPress={handleBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Results</Text>
        <Text style={styles.detectionCount}>{detections.length} detected</Text>
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
                      fill="rgba(0, 200, 83, 0.25)"
                      stroke="#00C853"
                      strokeWidth={2}
                    />
                    <SvgText
                      x={center.x}
                      y={center.y}
                      fill="#00C853"
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
        <View style={styles.primaryLeft}>
          <TouchableOpacity
            style={[styles.primaryTab, activeTab === 'books' && styles.primaryTabActive]}
            onPress={() => setActiveTab('books')}
          >
            <Text style={[styles.primaryTabText, activeTab === 'books' && styles.primaryTabTextActive]}>
              Books {bookCandidates.length > 0 && `(${bookCandidates.length})`}
            </Text>
          </TouchableOpacity>
        </View>
        {showDiagnosticsUI && (
          <TouchableOpacity
            style={[styles.diagnosticsToggle, diagnosticsVisible && styles.diagnosticsToggleActive]}
            onPress={() => {
              // Navigate to full DiagnosticsScreen with sessionId
              navigation.navigate('Diagnostics', { sessionId });
            }}
            onLongPress={() => {
              // Toggle inline overlay/crops on long-press
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
                      fill={isSelected ? 'rgba(0, 122, 255, 0.3)' : 'rgba(255, 149, 0, 0.2)'}
                      stroke={isSelected ? '#007AFF' : '#FF9500'}
                      strokeWidth={isSelected ? 3 : 2}
                      onPress={() => handleDetectionTap(index)}
                    />

                    {/* Center point */}
                    <Circle
                      cx={center.x}
                      cy={center.y}
                      r={isSelected ? 6 : 4}
                      fill={isSelected ? '#007AFF' : '#FF9500'}
                      onPress={() => handleDetectionTap(index)}
                    />

                    {/* Index label */}
                    <SvgText
                      x={center.x}
                      y={center.y - 12}
                      fill={isSelected ? '#007AFF' : '#FF9500'}
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
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Edit Book Info</Text>
              <TouchableOpacity onPress={handleCloseEditModal} style={styles.modalCloseButton}>
                <Text style={styles.modalCloseText}>Cancel</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.modalInputContainer}>
              <Text style={styles.modalInputLabel}>Title</Text>
              <TextInput
                style={styles.modalInput}
                value={editTitle}
                onChangeText={setEditTitle}
                placeholder="Enter book title"
                placeholderTextColor="#636366"
                autoCapitalize="words"
                autoCorrect={false}
              />
            </View>

            <View style={styles.modalInputContainer}>
              <Text style={styles.modalInputLabel}>Author</Text>
              <TextInput
                style={styles.modalInput}
                value={editAuthor}
                onChangeText={setEditAuthor}
                placeholder="Enter author name"
                placeholderTextColor="#636366"
                autoCapitalize="words"
                autoCorrect={false}
              />
            </View>

            <TouchableOpacity style={styles.modalSaveButton} onPress={handleSaveEdits}>
              <Text style={styles.modalSaveButtonText}>Save</Text>
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
        return { label: 'Accepted (High)', color: '#30D158', icon: '✓' };
      case 'accept_medium':
        return { label: 'Accepted', color: '#30D158', icon: '✓' };
      case 'suggested':
        return { label: 'Suggested', color: '#FF9F0A', icon: '~' };
      case 'reject':
        return { label: 'No Match', color: '#8E8E93', icon: '✗' };
      // Legacy action types (backwards compatibility)
      case 'auto-accept':
        return { label: 'Matched', color: '#30D158', icon: '✓' };
      case 'suggest':
        return { label: 'Suggested', color: '#FF9F0A', icon: '?' };
      case 'ambiguous':
        return { label: 'Ambiguous', color: '#FF453A', icon: '!' };
      case 'no-match':
        return { label: 'No Match', color: '#8E8E93', icon: '—' };
      default:
        return { label: 'Unknown', color: '#8E8E93', icon: '?' };
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
            evidenceSummary.sessionTier === 'strong' && { color: '#30D158' },
            evidenceSummary.sessionTier === 'usable' && { color: '#FF9F0A' },
            evidenceSummary.sessionTier === 'weak' && { color: '#FF453A' },
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
    backgroundColor: '#000',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  loadingText: {
    color: '#fff',
    fontSize: 16,
    marginTop: 16,
  },
  errorBanner: {
    backgroundColor: '#FF3B30',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  errorText: {
    color: '#fff',
    fontSize: 13,
    textAlign: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 12,
    backgroundColor: '#1c1c1e',
  },
  backButton: {
    padding: 8,
  },
  backButtonText: {
    color: '#007AFF',
    fontSize: 16,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  detectionCount: {
    color: '#8e8e93',
    fontSize: 14,
  },
  spinePreviewContainer: {
    height: 180,
    backgroundColor: '#000',
    marginHorizontal: 12,
    marginVertical: 8,
    borderRadius: 12,
    overflow: 'hidden',
  },
  spinePreviewImage: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  imageContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  image: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  infoPanel: {
    backgroundColor: '#1c1c1e',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#38383a',
  },
  infoPanelTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  infoRow: {
    flexDirection: 'row',
  },
  infoItem: {
    marginRight: 24,
  },
  infoLabel: {
    color: '#8e8e93',
    fontSize: 12,
    marginBottom: 4,
  },
  infoValue: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  listContainer: {
    backgroundColor: '#1c1c1e',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#38383a',
  },
  detectionChip: {
    backgroundColor: '#38383a',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
    marginRight: 8,
  },
  detectionChipSelected: {
    backgroundColor: '#007AFF',
  },
  detectionChipText: {
    color: '#fff',
    fontSize: 14,
  },
  detectionChipTextSelected: {
    fontWeight: '600',
  },
  // Tab bar styles
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#1c1c1e',
    borderBottomWidth: 1,
    borderBottomColor: '#38383a',
  },
  primaryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1c1c1e',
    borderBottomWidth: 1,
    borderBottomColor: '#38383a',
    paddingHorizontal: 12,
  },
  primaryLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  primaryTab: {
    paddingVertical: 12,
    paddingHorizontal: 8,
  },
  primaryTabActive: {
    borderBottomWidth: 2,
    borderBottomColor: '#007AFF',
  },
  primaryTabText: {
    color: '#8e8e93',
    fontSize: 15,
    fontWeight: '600',
  },
  primaryTabTextActive: {
    color: '#007AFF',
  },
  diagnosticsToggle: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: '#2c2c2e',
  },
  diagnosticsToggleActive: {
    backgroundColor: '#007AFF',
  },
  diagnosticsToggleText: {
    color: '#8e8e93',
    fontSize: 12,
    fontWeight: '600',
  },
  diagnosticsToggleTextActive: {
    color: '#fff',
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: '#007AFF',
  },
  tabText: {
    color: '#8e8e93',
    fontSize: 15,
    fontWeight: '500',
  },
  tabTextActive: {
    color: '#007AFF',
  },
  // Crops view styles
  cropsContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  cropsScrollContent: {
    padding: 16,
  },
  noCropsContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  noCropsTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  noCropsMessage: {
    color: '#8e8e93',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 16,
  },
  noCropsStats: {
    color: '#636366',
    fontSize: 12,
    textAlign: 'center',
  },
  shareAllButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignSelf: 'center',
    marginBottom: 16,
  },
  shareAllButtonText: {
    color: '#fff',
    fontSize: 16,
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
    backgroundColor: '#1c1c1e',
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  cropCardSelected: {
    borderWidth: 2,
    borderColor: '#007AFF',
  },
  cropCardSkipped: {
    opacity: 0.5,
  },
  cropImage: {
    width: '100%',
    height: '100%',
  },
  cropOverlay: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  cropIndex: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  cropShareButton: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: '#007AFF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
  },
  cropShareButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  cropSkippedContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  cropSkippedIndex: {
    color: '#636366',
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 8,
  },
  cropSkippedText: {
    color: '#8e8e93',
    fontSize: 14,
    fontWeight: '500',
  },
  cropSkippedReason: {
    color: '#636366',
    fontSize: 11,
    marginTop: 4,
    textAlign: 'center',
  },
  cropsSummary: {
    paddingTop: 8,
    alignItems: 'center',
  },
  cropsSummaryText: {
    color: '#8e8e93',
    fontSize: 13,
    marginBottom: 4,
  },
  // OCR styles
  cropCardContainer: {
    marginRight: 16,
    marginBottom: 16,
    width: (SCREEN_WIDTH - 48) / 2,
  },
  ocrBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(52, 199, 89, 0.9)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  ocrBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
  ocrProcessingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  ocrInfoContainer: {
    paddingTop: 8,
    paddingHorizontal: 4,
    minHeight: 44,
  },
  ocrTitle: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 16,
  },
  ocrAuthor: {
    color: '#8e8e93',
    fontSize: 11,
    marginTop: 2,
  },
  ocrNoText: {
    color: '#636366',
    fontSize: 11,
    fontStyle: 'italic',
  },
  runOcrButton: {
    backgroundColor: '#38383a',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  runOcrButtonText: {
    color: '#007AFF',
    fontSize: 12,
    fontWeight: '500',
  },
  ocrUnavailable: {
    color: '#636366',
    fontSize: 11,
    fontStyle: 'italic',
  },
  ocrTextContainer: {
    flex: 1,
  },
  editHint: {
    color: '#007AFF',
    fontSize: 10,
    marginTop: 4,
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  modalContent: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: Platform.OS === 'ios' ? 40 : 20,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  modalTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  modalCloseButton: {
    padding: 8,
  },
  modalCloseText: {
    color: '#007AFF',
    fontSize: 16,
  },
  modalInputContainer: {
    marginBottom: 16,
  },
  modalInputLabel: {
    color: '#8e8e93',
    fontSize: 13,
    marginBottom: 8,
  },
  modalInput: {
    backgroundColor: '#38383a',
    borderRadius: 8,
    padding: 12,
    color: '#fff',
    fontSize: 16,
  },
  modalSaveButton: {
    backgroundColor: '#007AFF',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  modalSaveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  // Crop image container for rotation handling
  cropImageContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  // Rotation badge overlay
  rotationBadge: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    backgroundColor: 'rgba(88, 86, 214, 0.9)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  rotationBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
  // Error state for failed crop loads
  cropErrorContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#2c2c2e',
  },
  cropErrorIndex: {
    color: '#FF453A',
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 8,
  },
  cropErrorText: {
    color: '#FF453A',
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 4,
  },
  cropErrorFilename: {
    color: '#636366',
    fontSize: 10,
    textAlign: 'center',
  },
  // Full-screen preview modal styles
  previewModalContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 16,
    backgroundColor: '#1c1c1e',
  },
  previewCloseButton: {
    padding: 8,
  },
  previewCloseText: {
    color: '#007AFF',
    fontSize: 16,
  },
  previewHeaderTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  previewShareButton: {
    padding: 8,
  },
  previewShareText: {
    color: '#007AFF',
    fontSize: 16,
  },
  previewImageContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  previewInfoPanel: {
    backgroundColor: '#1c1c1e',
    padding: 20,
    paddingBottom: Platform.OS === 'ios' ? 40 : 20,
  },
  previewTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 8,
  },
  previewAuthor: {
    color: '#8e8e93',
    fontSize: 16,
    marginBottom: 12,
  },
  previewOcrStats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 16,
  },
  previewOcrStatsText: {
    color: '#636366',
    fontSize: 13,
    marginRight: 16,
  },
  previewNoText: {
    color: '#636366',
    fontSize: 14,
    fontStyle: 'italic',
    marginBottom: 16,
  },
  previewEditButton: {
    backgroundColor: '#38383a',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  previewEditButtonText: {
    color: '#007AFF',
    fontSize: 15,
    fontWeight: '500',
  },
  // Books view styles (Gate 7)
  booksContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  booksScrollContent: {
    padding: 16,
  },
  booksSummaryHeader: {
    backgroundColor: '#1c1c1e',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  booksSummaryText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  booksSummarySubtext: {
    color: '#8e8e93',
    fontSize: 13,
    marginTop: 4,
  },
  debugSummary: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#2c2c2e',
  },
  debugSummaryText: {
    color: '#8e8e93',
    fontSize: 12,
    marginTop: 2,
  },
  statusFilterContainer: {
    flexDirection: 'row',
    marginTop: 12,
    gap: 8,
  },
  statusFilterButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#2c2c2e',
    borderWidth: 1,
    borderColor: '#3c3c3e',
  },
  statusFilterButtonActive: {
    backgroundColor: '#0a84ff',
    borderColor: '#0a84ff',
  },
  statusFilterButtonReject: {
    backgroundColor: '#ff453a',
    borderColor: '#ff453a',
  },
  statusFilterButtonText: {
    color: '#8e8e93',
    fontSize: 13,
    fontWeight: '500',
  },
  statusFilterButtonTextActive: {
    color: '#ffffff',
  },
  exportButton: {
    backgroundColor: '#5856d6',
    borderColor: '#5856d6',
  },
  bookCard: {
    backgroundColor: '#1c1c1e',
    borderRadius: 12,
    marginBottom: 16,
    overflow: 'hidden',
  },
  bookCardHeader: {
    flexDirection: 'row',
    padding: 12,
  },
  bookCardThumbnail: {
    width: 60,
    height: 80,
    borderRadius: 6,
    backgroundColor: '#38383a',
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
    color: '#636366',
    fontSize: 20,
    fontWeight: '600',
  },
  bookCardInfo: {
    flex: 1,
    marginLeft: 12,
  },
  bookCardIndex: {
    color: '#8e8e93',
    fontSize: 11,
    fontWeight: '500',
    marginBottom: 4,
  },
  bookCardTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 20,
  },
  bookCardNoTitle: {
    color: '#636366',
    fontSize: 14,
    fontStyle: 'italic',
  },
  bookCardAuthor: {
    color: '#8e8e93',
    fontSize: 13,
    marginTop: 2,
  },
  bookCardMeta: {
    marginTop: 8,
  },
  bookCardMetaText: {
    color: '#636366',
    fontSize: 11,
  },
  bookEvidenceContainer: {
    padding: 12,
    paddingTop: 0,
    borderTopWidth: 1,
    borderTopColor: '#38383a',
    marginTop: 4,
  },
  bookEvidenceLabel: {
    color: '#8e8e93',
    fontSize: 11,
    fontWeight: '500',
    marginBottom: 6,
    marginTop: 12,
  },
  bookEvidenceText: {
    color: '#a0a0a5',
    fontSize: 12,
    lineHeight: 18,
  },
  bookEvidenceCount: {
    color: '#636366',
    fontSize: 10,
    marginTop: 8,
  },
  bookCropsStrip: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    marginTop: 8,
  },
  bookCropThumb: {
    width: 44,
    height: 60,
    borderRadius: 4,
    marginRight: 8,
    backgroundColor: '#38383a',
  },
  // Metadata Resolution Card styles (Gate 8+)
  metadataCard: {
    backgroundColor: '#1c1c1e',
    borderRadius: 12,
    padding: 16,
    marginTop: 16,
    marginBottom: 16,
  },
  metadataCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  metadataCardTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  metadataStatusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  metadataStatusText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  metadataNoData: {
    color: '#8e8e93',
    fontSize: 14,
    marginBottom: 16,
    textAlign: 'center',
  },
  metadataLabel: {
    color: '#8e8e93',
    fontSize: 13,
  },
  metadataEvidenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  metadataEvidenceTier: {
    color: '#8e8e93',
    fontSize: 13,
    fontWeight: '600',
    marginLeft: 8,
  },
  metadataOfflineBadge: {
    backgroundColor: '#3a3a3c',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    marginBottom: 12,
  },
  metadataOfflineText: {
    color: '#FF9F0A',
    fontSize: 12,
    textAlign: 'center',
  },
  metadataBookInfo: {
    backgroundColor: '#2c2c2e',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  metadataBookTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  metadataBookAuthor: {
    color: '#a0a0a5',
    fontSize: 14,
    marginBottom: 8,
  },
  metadataBookMeta: {
    color: '#8e8e93',
    fontSize: 12,
    marginBottom: 2,
  },
  metadataBookIsbn: {
    color: '#636366',
    fontSize: 11,
    marginTop: 6,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  metadataConfidence: {
    color: '#30D158',
    fontSize: 12,
    fontWeight: '500',
    marginTop: 8,
  },
  metadataWarnings: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    marginBottom: 12,
  },
  metadataWarningsLabel: {
    color: '#8e8e93',
    fontSize: 12,
    marginRight: 8,
  },
  metadataWarningBadge: {
    backgroundColor: '#FF453A33',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    marginRight: 6,
    marginBottom: 4,
  },
  metadataWarningText: {
    color: '#FF453A',
    fontSize: 11,
  },
  metadataAlternatives: {
    marginBottom: 12,
  },
  metadataAlternativesLabel: {
    color: '#8e8e93',
    fontSize: 12,
    marginBottom: 8,
  },
  metadataAlternativeItem: {
    backgroundColor: '#2c2c2e',
    borderRadius: 6,
    padding: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  metadataAlternativeSelected: {
    borderColor: '#007AFF',
  },
  metadataAlternativeTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  metadataAlternativeAuthor: {
    color: '#8e8e93',
    fontSize: 12,
    marginTop: 2,
  },
  metadataNoMatch: {
    backgroundColor: '#3a3a3c',
    borderRadius: 6,
    padding: 12,
    marginBottom: 12,
  },
  metadataNoMatchText: {
    color: '#8e8e93',
    fontSize: 13,
    textAlign: 'center',
  },
  metadataRetryButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  metadataRetryButtonDisabled: {
    backgroundColor: '#38383a',
  },
  metadataRetryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});

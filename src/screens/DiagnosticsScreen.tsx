/**
 * DiagnosticsScreen - Shows detailed pipeline diagnostics
 *
 * Only accessible when __DEV__ && diagnosticsEnabled
 */

import React, { useEffect, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList, PipelineTimings, DebugManifest, ResolvedBook } from '../types';
import { useAppStore } from '../store/useAppStore';
import { useDebugStore, type WriteStats } from '../store/useDebugStore';
import { readDebugManifest } from '../services/debugArtifacts';
import { testOpenLibraryIsbnResolution, buildResolverKey, OpenLibraryProvider } from '../services/openLibraryProvider';
import { buildEvidenceTokens } from '../services/evidenceNormalization';
import { generateHypotheses } from '../services/queryHypotheses';
import { upsertResolvedBook, testBooksCatalogWrite } from '../services/booksCatalogService';
import { isSupabaseConfigured, getSupabaseBaseUrl, getSupabaseAnonKey, getSupabaseClient } from '../config/supabase';
import { getCapabilities, clearCapabilitiesCache, type SupabaseCapabilities } from '../services/supabaseCapabilities';

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Diagnostics'>;
type DiagnosticsRouteProp = RouteProp<RootStackParamList, 'Diagnostics'>;

// Format duration in ms
function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// Smoke test result type
interface SmokeTestResult {
  running: boolean;
  success?: boolean;
  message?: string;
  book?: ResolvedBook;
  bookId?: string;
  resolverKey?: string;
  errorDetail?: string;
  errorCode?: string;
  upsertMode?: 'resolver_key' | 'legacy';
}

// Supabase sanity check result type
interface SupabaseSanityResult {
  checking: boolean;
  connected?: boolean;
  rowCount?: number;
  error?: string;
}

// Capabilities check result type
interface CapabilitiesCheckResult {
  checking: boolean;
  capabilities?: SupabaseCapabilities;
}

export function DiagnosticsScreen(): React.JSX.Element {
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<DiagnosticsRouteProp>();
  // sessionId is optional - screen can work without it (for smoke tests only)
  const sessionId = route.params?.sessionId;
  const hasSessionId = !!sessionId;

  const { sessionMeta } = useAppStore();
  const writeStats = useDebugStore((state) => state.writeStats);
  const resetWriteStats = useDebugStore((state) => state.resetWriteStats);
  const [manifest, setManifest] = useState<DebugManifest | null>(null);
  const [loading, setLoading] = useState(hasSessionId);
  const [olSmokeTest, setOlSmokeTest] = useState<SmokeTestResult>({ running: false });
  const [catalogSmokeTest, setCatalogSmokeTest] = useState<SmokeTestResult>({ running: false });
  const [supabaseSanity, setSupabaseSanity] = useState<SupabaseSanityResult>({ checking: false });
  const [capabilitiesCheck, setCapabilitiesCheck] = useState<CapabilitiesCheckResult>({ checking: false });
  const [evidenceSmokeTest, setEvidenceSmokeTest] = useState<{
    running: boolean;
    success?: boolean;
    message?: string;
    hypothesesCount?: number;
    candidatesFound?: number;
    topScore?: number;
    decision?: string;
    pass1Decision?: string;
    passUsed?: number;
    boostTriggered?: boolean;
    queriesTriedCount?: number;
    reason?: string;
    scoreGap?: number;
    overlapCount?: number;
    isbnMatched?: boolean;
    errorDetail?: string;
  }>({ running: false });

  // ALWAYS-ON: Log on mount and auto-fetch catalog count
  useEffect(() => {
    console.log('[DiagnosticsScreen] mounted');

    // Log Supabase config info
    const supabaseUrl = getSupabaseBaseUrl();
    const anonKey = getSupabaseAnonKey();
    // Extract hostname from URL (avoid URL class which may have limited RN support)
    const urlHost = supabaseUrl
      ? supabaseUrl.replace(/^https?:\/\//, '').split('/')[0]
      : 'not configured';
    const anonKeyPrefix = anonKey ? anonKey.slice(0, 20) + '...' : 'not configured';
    console.log(`[Supabase] urlHost=${urlHost} anonKeyPrefix=${anonKeyPrefix}`);
    console.log(`[Supabase] configured=${isSupabaseConfigured()}`);

    // Auto-fetch books_catalog count on mount for clarity
    if (isSupabaseConfigured()) {
      runSupabaseSanityCheck();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hasSessionId) {
      // No session to load - skip manifest loading
      return;
    }

    async function loadManifest() {
      try {
        const data = await readDebugManifest(sessionId!);
        setManifest(data);
      } catch (e) {
        console.error('[DiagnosticsScreen] Failed to load manifest:', e);
      } finally {
        setLoading(false);
      }
    }
    loadManifest();
  }, [sessionId, hasSessionId]);

  const handleBack = () => {
    navigation.goBack();
  };

  // Run Open Library ISBN resolution smoke test
  const runOpenLibrarySmokeTest = async () => {
    console.log('[SmokeTest] openlibrary starting...');
    setOlSmokeTest({ running: true });
    try {
      const result = await testOpenLibraryIsbnResolution();
      console.log('[SmokeTest] openlibrary result=', {
        success: result.success,
        hasIsbn: result.hasIsbn,
        title: result.book?.title,
        isbn13: result.book?.isbn13,
        error: result.error,
      });
      if (result.success && result.book) {
        setOlSmokeTest({
          running: false,
          success: true,
          message: `Found: "${result.book.title}" ISBN: ${result.book.isbn13 || result.book.isbn10 || 'none'}`,
          book: result.book,
        });
      } else {
        setOlSmokeTest({
          running: false,
          success: false,
          message: result.error || 'No results found',
        });
      }
    } catch (e: any) {
      console.log('[SmokeTest] openlibrary error=', e.message);
      setOlSmokeTest({
        running: false,
        success: false,
        message: e.message || 'Test failed',
      });
    }
  };

  // Run full smoke test: OL search -> catalog persist (AUTHORITATIVE)
  const runFullSmokeTest = async () => {
    console.log('[FullPipelineTest] Starting...');
    setCatalogSmokeTest({ running: true });

    try {
      // Step 1: Search Open Library
      console.log('[FullPipelineTest] step=search starting...');
      const olResult = await testOpenLibraryIsbnResolution();
      const searchOk = olResult.success && olResult.book;
      console.log(`[FullPipelineTest] step=search ok=${searchOk} title="${olResult.book?.title}" isbn13=${olResult.book?.isbn13} isbn10=${olResult.book?.isbn10} error=${olResult.error || 'none'}`);

      if (!searchOk || !olResult.book) {
        setCatalogSmokeTest({
          running: false,
          success: false,
          message: 'Open Library search failed',
          errorDetail: olResult.error || 'No results returned',
        });
        return;
      }

      // REQUIRE: Book must have sourceId for resolver_key
      if (!olResult.book.sourceId) {
        console.log('[FullPipelineTest] step=search FAIL - no sourceId');
        setCatalogSmokeTest({
          running: false,
          success: false,
          message: 'Book missing sourceId',
          errorDetail: 'Open Library returned book without sourceId (OLID)',
        });
        return;
      }

      // Build resolver_key
      const resolverKey = buildResolverKey(olResult.book);
      console.log(`[FullPipelineTest] resolver_key="${resolverKey}"`);

      // Get current capabilities to know what mode will be used
      const caps = await getCapabilities();
      const expectedMode = caps.supportsResolverKey ? 'resolver_key' : 'legacy';
      console.log(`[FullPipelineTest] capabilities: supportsResolverKey=${caps.supportsResolverKey} mode=${expectedMode}`);

      // Step 2: Persist to books_catalog
      console.log('[FullPipelineTest] step=persist starting...');
      const catalogResult = await upsertResolvedBook(olResult.book);
      const resultDetails = catalogResult.details as { code?: string; mode?: string } | undefined;
      const upsertMode = (resultDetails?.mode as 'resolver_key' | 'legacy') || expectedMode;
      console.log(`[FullPipelineTest] step=persist ok=${catalogResult.success} bookId=${catalogResult.bookId || 'none'} mode=${upsertMode} error=${catalogResult.error || 'none'}`);

      if (catalogResult.success && catalogResult.bookId) {
        setCatalogSmokeTest({
          running: false,
          success: true,
          message: `SUCCESS: "${olResult.book.title}"`,
          book: olResult.book,
          bookId: catalogResult.bookId,
          resolverKey,
          upsertMode,
        });
      } else {
        const errorCode = resultDetails?.code || 'UNKNOWN';
        setCatalogSmokeTest({
          running: false,
          success: false,
          message: 'Catalog upsert FAILED',
          errorDetail: catalogResult.error || 'Unknown error',
          errorCode,
          resolverKey,
          upsertMode,
        });
      }
    } catch (e: any) {
      console.log(`[FullPipelineTest] EXCEPTION: ${e.message}`);
      setCatalogSmokeTest({
        running: false,
        success: false,
        message: 'Exception thrown',
        errorDetail: e.message || 'Unknown exception',
      });
    }
  };

  // Run Supabase sanity check
  const runSupabaseSanityCheck = async () => {
    console.log('[SupabaseSanity] Starting check...');
    setSupabaseSanity({ checking: true });

    if (!isSupabaseConfigured()) {
      console.log('[SupabaseSanity] Not configured');
      setSupabaseSanity({
        checking: false,
        connected: false,
        error: 'Supabase not configured',
      });
      return;
    }

    const client = getSupabaseClient();
    if (!client) {
      console.log('[SupabaseSanity] No client');
      setSupabaseSanity({
        checking: false,
        connected: false,
        error: 'Failed to create Supabase client',
      });
      return;
    }

    try {
      // Do a cheap count query on books_catalog
      const { count, error } = await client
        .from('books_catalog')
        .select('*', { count: 'exact', head: true });

      if (error) {
        console.log(`[SupabaseSanity] Query error: ${error.message}`);
        setSupabaseSanity({
          checking: false,
          connected: false,
          error: `${error.code}: ${error.message}`,
        });
      } else {
        console.log(`[SupabaseSanity] OK, row count=${count}`);
        setSupabaseSanity({
          checking: false,
          connected: true,
          rowCount: count ?? 0,
        });
      }
    } catch (e: any) {
      console.log(`[SupabaseSanity] Exception: ${e.message}`);
      setSupabaseSanity({
        checking: false,
        connected: false,
        error: e.message,
      });
    }
  };

  // Run Supabase capabilities check
  const runCapabilitiesCheck = async (forceRefresh = false) => {
    console.log('[CapabilitiesCheck] Starting...');
    setCapabilitiesCheck({ checking: true });

    if (forceRefresh) {
      clearCapabilitiesCache();
    }

    try {
      const caps = await getCapabilities(forceRefresh);
      console.log(`[CapabilitiesCheck] Result: supportsResolverKey=${caps.supportsResolverKey}`);
      setCapabilitiesCheck({
        checking: false,
        capabilities: caps,
      });
    } catch (e: any) {
      console.log(`[CapabilitiesCheck] Exception: ${e.message}`);
      setCapabilitiesCheck({
        checking: false,
        capabilities: {
          supportsResolverKey: false,
          probedAt: Date.now(),
          lastError: { code: 'EXCEPTION', message: e.message },
        },
      });
    }
  };

  // Run evidence-based search smoke test
  // Simulates OCR evidence lines with swapped title/author to test evidence-driven resolution
  const runEvidenceSmokeTest = async () => {
    console.log('[EvidenceSmokeTest] Starting...');
    setEvidenceSmokeTest({ running: true });

    try {
      // Simulate evidence where title/author might be in wrong order or misassigned
      // This tests that evidence-driven resolution can find the book anyway
      const testEvidence = [
        'STEPHEN KING',
        'THE SHINING',
        'A NOVEL',
      ];

      console.log('[EvidenceSmokeTest] Test evidence:', testEvidence);

      // Generate hypotheses
      const hypothesisResult = generateHypotheses(testEvidence);
      console.log(`[EvidenceSmokeTest] Generated ${hypothesisResult.hypotheses.length} hypotheses`);

      // Search using evidence
      const provider = new OpenLibraryProvider();
      const result = await provider.searchByEvidence(testEvidence);

      console.log(`[EvidenceSmokeTest] Decision: ${result.decision}, pass1Decision: ${result.pass1Decision || 'N/A'}, boostTriggered: ${result.boostTriggered}, candidates: ${result.scoredCandidates.length}, reason: ${result.reason}`);

      if (result.scoredCandidates.length > 0) {
        const top = result.scoredCandidates[0];
        const isAutoAccept = result.decision === 'accept_high' || result.decision === 'accept_medium';
        setEvidenceSmokeTest({
          running: false,
          success: isAutoAccept || result.decision === 'suggested',
          message: `Found: "${top.book.title}"`,
          hypothesesCount: result.hypothesisResults.length,
          candidatesFound: result.scoredCandidates.length,
          topScore: top.scoring.score,
          decision: result.decision,
          pass1Decision: result.pass1Decision,
          passUsed: result.passUsed,
          boostTriggered: result.boostTriggered,
          queriesTriedCount: result.queriesTriedCount,
          reason: result.reason,
          scoreGap: result.scoreGap,
          overlapCount: top.scoring.overlapCount,
          isbnMatched: top.scoring.isbnMatched,
        });
      } else {
        setEvidenceSmokeTest({
          running: false,
          success: false,
          message: 'No candidates found',
          hypothesesCount: result.hypothesisResults.length,
          candidatesFound: 0,
          decision: result.decision,
          pass1Decision: result.pass1Decision,
          passUsed: result.passUsed,
          boostTriggered: result.boostTriggered,
          queriesTriedCount: result.queriesTriedCount,
          reason: result.reason,
        });
      }
    } catch (e: any) {
      console.log(`[EvidenceSmokeTest] Exception: ${e.message}`);
      setEvidenceSmokeTest({
        running: false,
        success: false,
        message: 'Exception thrown',
        errorDetail: e.message,
      });
    }
  };

  const timings = manifest?.timings;
  const bookCandidates = sessionMeta?.bookCandidates ?? [];
  const metadataResolution = sessionMeta?.metadataResolution;
  const evidenceSummary = sessionMeta?.evidenceSummary;

  // Compute resolver stats
  const resolverStats = {
    total: bookCandidates.length,
    accepted: bookCandidates.filter(c => c.resolverDecision === 'accept').length,
    rejected: bookCandidates.filter(c => c.resolverDecision === 'reject').length,
    suggested: bookCandidates.filter(c => c.resolverDecision === 'suggested').length,
    pending: bookCandidates.filter(c => c.resolverDecision === 'pending' || !c.resolverDecision).length,
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={handleBack} style={styles.backButton}>
            <Text style={styles.backButtonText}>Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Diagnostics</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Loading diagnostics...</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Diagnostics</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* Session Info - only show if sessionId provided */}
        {hasSessionId && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Session</Text>
            <View style={styles.row}>
              <Text style={styles.label}>ID</Text>
              <Text style={styles.value}>{sessionId!.slice(0, 12)}...</Text>
            </View>
            {manifest?.createdAt && (
              <View style={styles.row}>
                <Text style={styles.label}>Created</Text>
                <Text style={styles.value}>
                  {new Date(manifest.createdAt).toLocaleString()}
                </Text>
              </View>
            )}
            {manifest?.source && (
              <View style={styles.row}>
                <Text style={styles.label}>Source</Text>
                <Text style={styles.value}>{manifest.source}</Text>
              </View>
            )}
          </View>
        )}

        {/* Pipeline Timings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pipeline Timings</Text>
          {timings ? (
            <>
              <TimingRow label="Acquisition" value={timings.acquisition} />
              <TimingRow label="Meta" value={timings.meta} />
              <TimingRow label="Letterbox" value={timings.letterbox} />
              <TimingRow label="Inference" value={timings.inference} />
              <TimingRow label="Postprocess" value={timings.postprocess} />
              <TimingRow label="Rectification" value={timings.rectification} />
              <TimingRow label="OCR" value={timings.ocr} />
              <TimingRow label="Grouping" value={timings.grouping} />
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Total</Text>
                <Text style={styles.totalValue}>{formatDuration(timings.total)}</Text>
              </View>
            </>
          ) : (
            <Text style={styles.noData}>No timing data available</Text>
          )}
        </View>

        {/* Detection Counts */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Counts</Text>
          <View style={styles.row}>
            <Text style={styles.label}>Raw Detections</Text>
            <Text style={styles.value}>{manifest?.detectionsOriginal?.length ?? '-'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Rectified Crops</Text>
            <Text style={styles.value}>
              {sessionMeta?.rectificationSummary?.succeeded ?? '-'}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Book Candidates</Text>
            <Text style={styles.value}>{bookCandidates.length}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>OCR Results</Text>
            <Text style={styles.value}>
              {sessionMeta?.ocrSummary?.succeeded ?? '-'}
            </Text>
          </View>
        </View>

        {/* Evidence Summary */}
        {evidenceSummary && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Evidence Quality</Text>
            <View style={styles.row}>
              <Text style={styles.label}>Session Tier</Text>
              <Text style={[styles.value, styles.tierBadge, getTierStyle(evidenceSummary.sessionTier)]}>
                {evidenceSummary.sessionTier}
              </Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Strong</Text>
              <Text style={styles.value}>{evidenceSummary.tierCounts.strong}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Usable</Text>
              <Text style={styles.value}>{evidenceSummary.tierCounts.usable}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Weak</Text>
              <Text style={styles.value}>{evidenceSummary.tierCounts.weak}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Unusable</Text>
              <Text style={styles.value}>{evidenceSummary.tierCounts.unusable}</Text>
            </View>
          </View>
        )}

        {/* Session Candidates Breakdown */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Session Candidates ({resolverStats.total})</Text>
          <Text style={styles.sectionSubtitle}>Breakdown by resolver decision</Text>

          {/* Decision breakdown */}
          <View style={styles.decisionGrid}>
            <View style={styles.decisionItem}>
              <Text style={[styles.decisionCount, styles.acceptedValue]}>{resolverStats.accepted}</Text>
              <Text style={styles.decisionLabel}>Accepted</Text>
              <Text style={styles.decisionDesc}>Persisted to catalog</Text>
            </View>
            <View style={styles.decisionItem}>
              <Text style={[styles.decisionCount, styles.reviewValue]}>{resolverStats.suggested}</Text>
              <Text style={styles.decisionLabel}>Suggested</Text>
              <Text style={styles.decisionDesc}>Not persisted</Text>
            </View>
            <View style={styles.decisionItem}>
              <Text style={[styles.decisionCount, styles.rejectedValue]}>{resolverStats.rejected}</Text>
              <Text style={styles.decisionLabel}>Rejected</Text>
              <Text style={styles.decisionDesc}>No match</Text>
            </View>
            <View style={styles.decisionItem}>
              <Text style={[styles.decisionCount, { color: '#8e8e93' }]}>{resolverStats.pending}</Text>
              <Text style={styles.decisionLabel}>Pending</Text>
              <Text style={styles.decisionDesc}>Not resolved</Text>
            </View>
          </View>

          {/* Catalog count comparison */}
          <View style={styles.catalogComparison}>
            <View style={styles.row}>
              <Text style={styles.label}>books_catalog rows (total)</Text>
              <Text style={[styles.value, styles.catalogValue]}>
                {supabaseSanity.checking
                  ? '...'
                  : supabaseSanity.rowCount !== undefined
                    ? supabaseSanity.rowCount.toLocaleString()
                    : supabaseSanity.error
                      ? 'Error'
                      : '-'}
              </Text>
            </View>
            {supabaseSanity.error && (
              <Text style={styles.catalogError}>{supabaseSanity.error}</Text>
            )}
          </View>
        </View>

        {/* Persistence Observability (Task 3) */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Persistence Stats</Text>
          <Text style={styles.sectionSubtitle}>books_catalog write tracking</Text>

          <View style={styles.row}>
            <Text style={styles.label}>Writes Attempted</Text>
            <Text style={styles.value}>{writeStats.writesAttempted}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Writes Succeeded</Text>
            <Text style={[styles.value, styles.acceptedValue]}>{writeStats.writesSucceeded}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Writes Failed</Text>
            <Text style={[styles.value, writeStats.writesFailed > 0 ? styles.rejectedValue : {}]}>
              {writeStats.writesFailed}
            </Text>
          </View>

          {/* Alert if accepts exist but writes failed */}
          {resolverStats.accepted > 0 && writeStats.writesFailed > 0 && (
            <View style={styles.writeAlert}>
              <Text style={styles.writeAlertText}>
                ⚠️ {writeStats.writesFailed} write(s) failed with {resolverStats.accepted} accept(s)
              </Text>
            </View>
          )}

          {writeStats.lastWriteError && (
            <View style={styles.row}>
              <Text style={styles.label}>Last Error</Text>
              <Text style={[styles.value, styles.rejectedValue]} numberOfLines={2}>
                {writeStats.lastWriteError}
              </Text>
            </View>
          )}

          {writeStats.lastWriteTime && (
            <View style={styles.row}>
              <Text style={styles.label}>Last Write</Text>
              <Text style={styles.value}>
                {new Date(writeStats.lastWriteTime).toLocaleTimeString()}
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={styles.resetButton}
            onPress={resetWriteStats}
          >
            <Text style={styles.resetButtonText}>Reset Stats</Text>
          </TouchableOpacity>
        </View>

        {/* Metadata Resolution */}
        {metadataResolution && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Resolution State</Text>
            <View style={styles.row}>
              <Text style={styles.label}>Decision</Text>
              <Text style={styles.value}>{metadataResolution.decision?.action ?? '-'}</Text>
            </View>
            {metadataResolution.resolvedAt && (
              <View style={styles.row}>
                <Text style={styles.label}>Resolved At</Text>
                <Text style={styles.value}>
                  {new Date(metadataResolution.resolvedAt).toLocaleTimeString()}
                </Text>
              </View>
            )}
            {metadataResolution.resolvedBook && (
              <>
                <View style={styles.row}>
                  <Text style={styles.label}>Resolved Title</Text>
                  <Text style={styles.value} numberOfLines={1}>
                    {metadataResolution.resolvedBook.title}
                  </Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.label}>Source</Text>
                  <Text style={styles.value}>{metadataResolution.resolvedBook.source}</Text>
                </View>
              </>
            )}
          </View>
        )}

        {/* Errors */}
        {manifest?.errors && manifest.errors.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, styles.errorTitle]}>Errors</Text>
            {manifest.errors.map((error, i) => (
              <Text key={i} style={styles.errorText}>{error}</Text>
            ))}
          </View>
        )}

        {/* Smoke Tests */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Smoke Tests</Text>

          {/* Open Library Test */}
          <View style={styles.smokeTestRow}>
            <View style={styles.smokeTestInfo}>
              <Text style={styles.smokeTestLabel}>Open Library ISBN</Text>
              <Text style={styles.smokeTestDesc}>
                Search "The Shining Stephen King" and verify ISBN
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.smokeTestButton, olSmokeTest.running && styles.smokeTestButtonDisabled]}
              onPress={runOpenLibrarySmokeTest}
              disabled={olSmokeTest.running}
            >
              {olSmokeTest.running ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.smokeTestButtonText}>Run</Text>
              )}
            </TouchableOpacity>
          </View>
          {olSmokeTest.message && (
            <View style={[styles.smokeTestResult, olSmokeTest.success ? styles.smokeTestSuccess : styles.smokeTestError]}>
              <Text style={styles.smokeTestResultText} numberOfLines={2}>
                {olSmokeTest.success ? '✓' : '✗'} {olSmokeTest.message}
              </Text>
            </View>
          )}

          {/* Full Pipeline Test */}
          <View style={[styles.smokeTestRow, { marginTop: 16 }]}>
            <View style={styles.smokeTestInfo}>
              <Text style={styles.smokeTestLabel}>Full Pipeline</Text>
              <Text style={styles.smokeTestDesc}>
                Search + persist to books_catalog
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.smokeTestButton, catalogSmokeTest.running && styles.smokeTestButtonDisabled]}
              onPress={runFullSmokeTest}
              disabled={catalogSmokeTest.running}
            >
              {catalogSmokeTest.running ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.smokeTestButtonText}>Run</Text>
              )}
            </TouchableOpacity>
          </View>
          {catalogSmokeTest.message && (
            <View style={[styles.smokeTestResult, catalogSmokeTest.success ? styles.smokeTestSuccess : styles.smokeTestError]}>
              <Text style={styles.smokeTestResultText}>
                {catalogSmokeTest.success ? '✓' : '✗'} {catalogSmokeTest.message}
              </Text>
              {catalogSmokeTest.bookId && (
                <Text style={styles.smokeTestBookId}>
                  bookId: {catalogSmokeTest.bookId}
                </Text>
              )}
              {catalogSmokeTest.resolverKey && (
                <Text style={styles.smokeTestBookId}>
                  resolver_key: {catalogSmokeTest.resolverKey}
                </Text>
              )}
              {catalogSmokeTest.upsertMode && (
                <Text style={[styles.smokeTestBookId, { color: catalogSmokeTest.upsertMode === 'resolver_key' ? '#30D158' : '#FF9F0A' }]}>
                  mode: {catalogSmokeTest.upsertMode}
                </Text>
              )}
              {catalogSmokeTest.book && (
                <>
                  <Text style={styles.smokeTestBookId}>
                    isbn13: {catalogSmokeTest.book.isbn13 || 'none'}
                  </Text>
                  <Text style={styles.smokeTestBookId}>
                    isbn10: {catalogSmokeTest.book.isbn10 || 'none'}
                  </Text>
                </>
              )}
              {catalogSmokeTest.errorCode && (
                <Text style={[styles.smokeTestBookId, { color: '#FF453A' }]}>
                  code: {catalogSmokeTest.errorCode}
                </Text>
              )}
              {catalogSmokeTest.errorDetail && (
                <Text style={[styles.smokeTestBookId, { color: '#FF453A' }]}>
                  error: {catalogSmokeTest.errorDetail}
                </Text>
              )}
            </View>
          )}

          {/* Evidence Search Test */}
          <View style={[styles.smokeTestRow, { marginTop: 16 }]}>
            <View style={styles.smokeTestInfo}>
              <Text style={styles.smokeTestLabel}>Evidence Search</Text>
              <Text style={styles.smokeTestDesc}>
                Test hypothesis-based resolution
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.smokeTestButton, evidenceSmokeTest.running && styles.smokeTestButtonDisabled]}
              onPress={runEvidenceSmokeTest}
              disabled={evidenceSmokeTest.running}
            >
              {evidenceSmokeTest.running ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.smokeTestButtonText}>Run</Text>
              )}
            </TouchableOpacity>
          </View>
          {evidenceSmokeTest.message && (
            <View style={[styles.smokeTestResult, evidenceSmokeTest.success ? styles.smokeTestSuccess : styles.smokeTestError]}>
              <Text style={styles.smokeTestResultText}>
                {evidenceSmokeTest.success ? '✓' : '✗'} {evidenceSmokeTest.message}
              </Text>
              {/* Pass Summary */}
              {evidenceSmokeTest.passUsed !== undefined && (
                <Text style={[styles.smokeTestBookId, { color: evidenceSmokeTest.boostTriggered ? '#FF9F0A' : '#30D158' }]}>
                  pass: {evidenceSmokeTest.passUsed} {evidenceSmokeTest.boostTriggered ? '(boost triggered)' : ''}
                </Text>
              )}
              {evidenceSmokeTest.pass1Decision && evidenceSmokeTest.boostTriggered && (
                <Text style={styles.smokeTestBookId}>
                  pass1: {evidenceSmokeTest.pass1Decision}
                </Text>
              )}
              {evidenceSmokeTest.queriesTriedCount !== undefined && (
                <Text style={styles.smokeTestBookId}>
                  queries tried: {evidenceSmokeTest.queriesTriedCount}
                </Text>
              )}
              {evidenceSmokeTest.candidatesFound !== undefined && (
                <Text style={styles.smokeTestBookId}>
                  candidates: {evidenceSmokeTest.candidatesFound}
                </Text>
              )}
              {evidenceSmokeTest.topScore !== undefined && (
                <Text style={[styles.smokeTestBookId, { color: evidenceSmokeTest.topScore >= 0.82 ? '#30D158' : '#FF9F0A' }]}>
                  top score: {Math.round(evidenceSmokeTest.topScore * 100)}%
                </Text>
              )}
              {evidenceSmokeTest.decision && (
                <Text style={[
                  styles.smokeTestBookId,
                  evidenceSmokeTest.decision === 'accept_high' && { color: '#30D158' },
                  evidenceSmokeTest.decision === 'accept_medium' && { color: '#30D158' },
                  evidenceSmokeTest.decision === 'suggested' && { color: '#FF9F0A' },
                  evidenceSmokeTest.decision === 'reject' && { color: '#FF453A' },
                ]}>
                  decision: {evidenceSmokeTest.decision}
                </Text>
              )}
              {evidenceSmokeTest.reason && (
                <Text style={[styles.smokeTestBookId, { fontSize: 10 }]} numberOfLines={2}>
                  {evidenceSmokeTest.reason}
                </Text>
              )}
              {evidenceSmokeTest.overlapCount !== undefined && (
                <Text style={styles.smokeTestBookId}>
                  overlap: {evidenceSmokeTest.overlapCount} tokens {evidenceSmokeTest.isbnMatched ? '(ISBN matched)' : ''}
                </Text>
              )}
              {evidenceSmokeTest.scoreGap !== undefined && evidenceSmokeTest.scoreGap < 1 && (
                <Text style={styles.smokeTestBookId}>
                  gap: {Math.round(evidenceSmokeTest.scoreGap * 100)}%
                </Text>
              )}
              {evidenceSmokeTest.errorDetail && (
                <Text style={[styles.smokeTestBookId, { color: '#FF453A' }]}>
                  error: {evidenceSmokeTest.errorDetail}
                </Text>
              )}
            </View>
          )}
        </View>

        {/* Supabase Runtime Sanity */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Supabase Runtime</Text>
          <View style={styles.row}>
            <Text style={styles.label}>URL</Text>
            <Text style={styles.value} numberOfLines={1}>
              {getSupabaseBaseUrl().replace(/^https?:\/\//, '').split('.')[0]}...supabase.co
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Project Ref</Text>
            <Text style={styles.value}>
              {getSupabaseBaseUrl().replace(/^https?:\/\//, '').split('.')[0]}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Anon Key</Text>
            <Text style={styles.value}>
              {getSupabaseAnonKey() ? `${getSupabaseAnonKey().slice(0, 20)}...` : 'missing'}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Configured</Text>
            <Text style={[styles.value, isSupabaseConfigured() ? styles.acceptedValue : styles.rejectedValue]}>
              {isSupabaseConfigured() ? 'Yes' : 'No'}
            </Text>
          </View>

          {/* Sanity Check Button */}
          <View style={[styles.smokeTestRow, { marginTop: 12 }]}>
            <View style={styles.smokeTestInfo}>
              <Text style={styles.smokeTestLabel}>Connection Test</Text>
              <Text style={styles.smokeTestDesc}>
                Query books_catalog count
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.smokeTestButton, supabaseSanity.checking && styles.smokeTestButtonDisabled]}
              onPress={runSupabaseSanityCheck}
              disabled={supabaseSanity.checking}
            >
              {supabaseSanity.checking ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.smokeTestButtonText}>Test</Text>
              )}
            </TouchableOpacity>
          </View>
          {supabaseSanity.connected !== undefined && (
            <View style={[styles.smokeTestResult, supabaseSanity.connected ? styles.smokeTestSuccess : styles.smokeTestError]}>
              <Text style={styles.smokeTestResultText}>
                {supabaseSanity.connected ? '✓' : '✗'} {supabaseSanity.connected ? 'Connected' : 'Failed'}
              </Text>
              {supabaseSanity.rowCount !== undefined && (
                <Text style={styles.smokeTestBookId}>
                  books_catalog rows: {supabaseSanity.rowCount}
                </Text>
              )}
              {supabaseSanity.error && (
                <Text style={[styles.smokeTestBookId, { color: '#FF453A' }]}>
                  error: {supabaseSanity.error}
                </Text>
              )}
            </View>
          )}
        </View>

        {/* Supabase Capabilities */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Supabase Capabilities</Text>
          <View style={styles.row}>
            <Text style={styles.label}>resolver_key Support</Text>
            <Text style={[
              styles.value,
              capabilitiesCheck.capabilities?.supportsResolverKey ? styles.acceptedValue : styles.reviewValue
            ]}>
              {capabilitiesCheck.capabilities === undefined
                ? 'Unknown'
                : capabilitiesCheck.capabilities.supportsResolverKey
                  ? 'Yes'
                  : 'No (Legacy Mode)'}
            </Text>
          </View>
          {capabilitiesCheck.capabilities?.probedAt && (
            <View style={styles.row}>
              <Text style={styles.label}>Last Probed</Text>
              <Text style={styles.value}>
                {new Date(capabilitiesCheck.capabilities.probedAt).toLocaleTimeString()}
              </Text>
            </View>
          )}
          {capabilitiesCheck.capabilities?.lastError && (
            <>
              <View style={styles.row}>
                <Text style={styles.label}>Error Code</Text>
                <Text style={[styles.value, styles.rejectedValue]}>
                  {capabilitiesCheck.capabilities.lastError.code}
                </Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>Error Message</Text>
                <Text style={[styles.value, { fontSize: 11 }]} numberOfLines={2}>
                  {capabilitiesCheck.capabilities.lastError.message}
                </Text>
              </View>
            </>
          )}

          {/* Probe Button */}
          <View style={[styles.smokeTestRow, { marginTop: 12 }]}>
            <View style={styles.smokeTestInfo}>
              <Text style={styles.smokeTestLabel}>Probe Capabilities</Text>
              <Text style={styles.smokeTestDesc}>
                Check resolver_key column
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.smokeTestButton, capabilitiesCheck.checking && styles.smokeTestButtonDisabled]}
              onPress={() => runCapabilitiesCheck(true)}
              disabled={capabilitiesCheck.checking}
            >
              {capabilitiesCheck.checking ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.smokeTestButtonText}>Probe</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

function TimingRow({ label, value }: { label: string; value: number | undefined }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{formatDuration(value)}</Text>
    </View>
  );
}

function getTierStyle(tier: string) {
  switch (tier) {
    case 'strong':
      return styles.tierStrong;
    case 'usable':
      return styles.tierUsable;
    case 'weak':
      return styles.tierWeak;
    default:
      return styles.tierUnusable;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
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
  headerSpacer: {
    width: 48,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#8e8e93',
    marginTop: 12,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  section: {
    backgroundColor: '#1c1c1e',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  sectionSubtitle: {
    color: '#8e8e93',
    fontSize: 12,
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  label: {
    color: '#8e8e93',
    fontSize: 14,
  },
  value: {
    color: '#fff',
    fontSize: 14,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 12,
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#2c2c2e',
  },
  totalLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  totalValue: {
    color: '#007AFF',
    fontSize: 15,
    fontWeight: '600',
  },
  noData: {
    color: '#636366',
    fontSize: 14,
    fontStyle: 'italic',
  },
  tierBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  tierStrong: {
    backgroundColor: '#30D158',
    color: '#000',
  },
  tierUsable: {
    backgroundColor: '#007AFF',
    color: '#fff',
  },
  tierWeak: {
    backgroundColor: '#FF9F0A',
    color: '#000',
  },
  tierUnusable: {
    backgroundColor: '#FF453A',
    color: '#fff',
  },
  acceptedValue: {
    color: '#30D158',
  },
  reviewValue: {
    color: '#FF9F0A',
  },
  rejectedValue: {
    color: '#FF453A',
  },
  // Decision grid styles
  decisionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
    marginBottom: 16,
  },
  decisionItem: {
    width: '50%',
    padding: 4,
  },
  decisionCount: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 2,
  },
  decisionLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  decisionDesc: {
    color: '#636366',
    fontSize: 11,
  },
  catalogComparison: {
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#2c2c2e',
  },
  catalogValue: {
    color: '#007AFF',
    fontWeight: '600',
  },
  catalogError: {
    color: '#FF453A',
    fontSize: 11,
    marginTop: 4,
  },
  writeAlert: {
    backgroundColor: 'rgba(255, 69, 58, 0.2)',
    padding: 8,
    borderRadius: 6,
    marginTop: 8,
  },
  writeAlertText: {
    color: '#FF453A',
    fontSize: 12,
    fontWeight: '500',
  },
  resetButton: {
    backgroundColor: '#2c2c2e',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    marginTop: 12,
    alignSelf: 'flex-start',
  },
  resetButtonText: {
    color: '#8e8e93',
    fontSize: 12,
    fontWeight: '500',
  },
  errorTitle: {
    color: '#FF453A',
  },
  errorText: {
    color: '#FF453A',
    fontSize: 13,
    marginBottom: 4,
  },
  smokeTestRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  smokeTestInfo: {
    flex: 1,
    marginRight: 12,
  },
  smokeTestLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  smokeTestDesc: {
    color: '#8e8e93',
    fontSize: 12,
    marginTop: 2,
  },
  smokeTestButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    minWidth: 60,
    alignItems: 'center',
  },
  smokeTestButtonDisabled: {
    backgroundColor: '#3c3c3e',
  },
  smokeTestButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  smokeTestResult: {
    marginTop: 8,
    padding: 8,
    borderRadius: 6,
  },
  smokeTestSuccess: {
    backgroundColor: 'rgba(48, 209, 88, 0.2)',
  },
  smokeTestError: {
    backgroundColor: 'rgba(255, 69, 58, 0.2)',
  },
  smokeTestResultText: {
    color: '#fff',
    fontSize: 12,
    fontFamily: 'Menlo',
  },
  smokeTestBookId: {
    color: '#8e8e93',
    fontSize: 11,
    fontFamily: 'Menlo',
    marginTop: 4,
  },
});

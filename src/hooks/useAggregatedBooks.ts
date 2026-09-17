import { useMemo, useState, useEffect, useCallback } from 'react';
import type { BookCandidate } from '../types';
import { useAppStore, storage } from '../store/useAppStore';
import type { SessionMeta, DetectionRectifyInfo } from '../store/useAppStore';
import { useBackgroundScanStore } from '../store/useBackgroundScanStore';

export interface AggregatedBook {
  candidate: BookCandidate;
  sessionId: string;
  sessionCreatedAt: string;
  dedupeKey: string;
  coverUri: string | null;
}

/** Diagnostic info for debugging pipeline data flow */
export interface AggregationDiagnostics {
  sessionCount: number;
  sessionsWithMeta: number;
  sessionsWithCandidates: number;
  totalCandidates: number;
  decisionCounts: Record<string, number>;
  details: string[];
}

function normalizeForDedupe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildDedupeKey(candidate: BookCandidate): string {
  const resolved = candidate.resolvedBook;
  if (resolved?.isbn13) return `isbn:${resolved.isbn13}`;
  if (resolved?.isbn10) return `isbn:${resolved.isbn10}`;
  const title = normalizeForDedupe(resolved?.title ?? '');
  const author = normalizeForDedupe(resolved?.authors?.[0] ?? '');
  return `ta:${title}:${author}`;
}

function resolveCoverUri(
  candidate: BookCandidate,
  rectResults: DetectionRectifyInfo[] | undefined,
): string | null {
  if (candidate.resolvedBook?.coverUrl) return candidate.resolvedBook.coverUrl;
  if (rectResults && candidate.cropIndices.length > 0) {
    const cropIdx = candidate.cropIndices[0];
    const rect = rectResults.find((r) => r.detectionIndex === cropIdx);
    if (rect?.cropUri) return rect.cropUri;
  }
  return null;
}

function isMatchedBook(candidate: BookCandidate): boolean {
  return (
    candidate.resolverDecision === 'accept' ||
    candidate.resolverDecision === 'suggested'
  );
}

function collectBooksFromMeta(
  meta: SessionMeta,
  sessionId: string,
  sessionCreatedAt: string,
): AggregatedBook[] {
  if (!meta.bookCandidates) return [];
  const results: AggregatedBook[] = [];
  for (const candidate of meta.bookCandidates) {
    if (!isMatchedBook(candidate)) continue;
    results.push({
      candidate,
      sessionId,
      sessionCreatedAt,
      dedupeKey: buildDedupeKey(candidate),
      coverUri: resolveCoverUri(candidate, meta.rectificationResults),
    });
  }
  return results;
}

export function useAggregatedBooks(): {
  books: AggregatedBook[];
  isLoading: boolean;
  totalCount: number;
  refresh: () => void;
  diagnostics: AggregationDiagnostics;
} {
  const sessions = useAppStore((s) => s.sessions);
  const liveSessionMeta = useAppStore((s) => s.sessionMeta);
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const bgScans = useBackgroundScanStore((s) => s.scans);

  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const bgScanCount = Object.keys(bgScans).length;
  useEffect(() => {
    if (bgScanCount === 0) {
      const timer = setTimeout(() => setRefreshKey((k) => k + 1), 3000);
      return () => clearTimeout(timer);
    }
  }, [bgScanCount]);

  const { books, diagnostics } = useMemo(() => {
    const all: AggregatedBook[] = [];
    const diag: AggregationDiagnostics = {
      sessionCount: sessions.length,
      sessionsWithMeta: 0,
      sessionsWithCandidates: 0,
      totalCandidates: 0,
      decisionCounts: {},
      details: [],
    };

    for (const session of sessions) {
      let meta: SessionMeta | null = null;

      // For the current foreground session, prefer in-memory state
      if (session.sessionId === currentSessionId && liveSessionMeta) {
        meta = liveSessionMeta;
        diag.details.push(`[${session.sessionId.slice(-8)}] live`);
      } else {
        try {
          const raw = storage.getString(`session_meta_${session.sessionId}`);
          if (raw) {
            meta = JSON.parse(raw) as SessionMeta;
            diag.details.push(`[${session.sessionId.slice(-8)}] mmkv`);
          } else {
            diag.details.push(`[${session.sessionId.slice(-8)}] no-mmkv`);
          }
        } catch {
          diag.details.push(`[${session.sessionId.slice(-8)}] parse-err`);
          continue;
        }
      }

      if (!meta) continue;
      diag.sessionsWithMeta++;

      // Show pipeline stage status for this session
      const rectCount = meta.rectificationResults?.length ?? 0;
      const rectOk = meta.rectificationResults?.filter(r => r.cropUri).length ?? 0;
      const ocrCount = Object.keys(meta.ocrResultsByCropIndex || {}).length;
      const resState = meta.metadataResolution?.decision?.action ?? 'none';
      diag.details.push(`  rect=${rectOk}/${rectCount} ocr=${ocrCount} res=${resState}`);

      const candidates = meta.bookCandidates;
      if (!candidates || candidates.length === 0) {
        diag.details.push(`  -> 0 candidates`);
        continue;
      }

      diag.sessionsWithCandidates++;
      diag.totalCandidates += candidates.length;

      for (const c of candidates) {
        const decision = c.resolverDecision ?? 'undefined';
        diag.decisionCounts[decision] = (diag.decisionCounts[decision] || 0) + 1;
      }
      diag.details.push(
        `  -> ${candidates.length} cands: ${candidates.map(c => c.resolverDecision ?? 'undef').join(', ')}`
      );

      all.push(...collectBooksFromMeta(meta, session.sessionId, session.createdAt));
    }

    // De-duplicate
    const byKey = new Map<string, AggregatedBook>();
    for (const book of all) {
      const existing = byKey.get(book.dedupeKey);
      if (!existing || book.candidate.confidenceScore > existing.candidate.confidenceScore) {
        byKey.set(book.dedupeKey, book);
      }
    }

    const deduped = Array.from(byKey.values());
    deduped.sort((a, b) => {
      const timeA = new Date(a.sessionCreatedAt).getTime();
      const timeB = new Date(b.sessionCreatedAt).getTime();
      if (timeA !== timeB) return timeB - timeA;
      return a.candidate.orderingKey - b.candidate.orderingKey;
    });

    return { books: deduped, diagnostics: diag };
  }, [sessions, liveSessionMeta, currentSessionId, bgScans, refreshKey]);

  return { books, isLoading: false, totalCount: books.length, refresh, diagnostics };
}

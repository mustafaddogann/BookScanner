/**
 * Timing utilities for pipeline stage measurements
 */

import type { StageTiming, PipelineTimings } from '../types';

/**
 * Timer class for measuring pipeline stages
 */
export class PipelineTimer {
  private stages: Map<string, StageTiming> = new Map();
  private currentStage: string | null = null;
  private pipelineStartTime: number;

  constructor() {
    this.pipelineStartTime = Date.now();
  }

  /**
   * Start timing a stage
   */
  startStage(stageName: string): void {
    if (this.currentStage) {
      this.endStage(this.currentStage);
    }

    this.currentStage = stageName;
    const startTime = Date.now();

    this.stages.set(stageName, {
      stageName,
      startTime,
      endTime: 0,
      durationMs: 0,
    });

    console.log(`[Timer] Starting stage: ${stageName}`);
  }

  /**
   * End timing a stage
   */
  endStage(stageName: string): number {
    const stage = this.stages.get(stageName);
    if (!stage) {
      console.warn(`[Timer] Stage not found: ${stageName}`);
      return 0;
    }

    stage.endTime = Date.now();
    stage.durationMs = stage.endTime - stage.startTime;

    if (this.currentStage === stageName) {
      this.currentStage = null;
    }

    console.log(`[Timer] Completed stage: ${stageName} in ${stage.durationMs}ms`);
    return stage.durationMs;
  }

  /**
   * Get timing for a specific stage
   */
  getStage(stageName: string): StageTiming | undefined {
    return this.stages.get(stageName);
  }

  /**
   * Get all stage timings
   */
  getAllStages(): StageTiming[] {
    return Array.from(this.stages.values());
  }

  /**
   * Get pipeline timings in the expected format
   */
  getTimings(): PipelineTimings {
    const timings: PipelineTimings = {};

    for (const [name, stage] of this.stages) {
      const key = this.stageNameToKey(name);
      if (key) {
        (timings as any)[key] = stage.durationMs;
      }
    }

    timings.total = Date.now() - this.pipelineStartTime;
    return timings;
  }

  /**
   * Map stage names to PipelineTimings keys
   */
  private stageNameToKey(stageName: string): keyof PipelineTimings | null {
    const mapping: Record<string, keyof PipelineTimings> = {
      'acquisition': 'acquisition',
      'meta': 'meta',
      'letterbox': 'letterbox',
      'inference': 'inference',
      'postprocess': 'postprocess',
      'overlay-prep': 'overlayPrep',
      'rectification': 'rectification',
    };
    return mapping[stageName] || null;
  }

  /**
   * Reset all timings
   */
  reset(): void {
    this.stages.clear();
    this.currentStage = null;
    this.pipelineStartTime = Date.now();
  }

  /**
   * Log summary of all stages
   */
  logSummary(): void {
    console.log('\n=== Pipeline Timing Summary ===');
    let total = 0;
    for (const stage of this.stages.values()) {
      console.log(`  ${stage.stageName}: ${stage.durationMs}ms`);
      total += stage.durationMs;
    }
    console.log(`  TOTAL: ${total}ms`);
    console.log('===============================\n');
  }
}

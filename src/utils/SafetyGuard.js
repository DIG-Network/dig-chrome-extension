/**
 * Safety Guard
 * Prevents infinite loops, recursion, and short-circuiting
 * 
 * @module SafetyGuard
 */

import Logger from './Logger.js';

class SafetyGuard {
  constructor() {
    this.logger = new Logger('SafetyGuard');
    this.processing = new Map(); // URL -> processing info
    this.processed = new Set(); // URLs that were successfully processed
    this.callCounts = new Map(); // URL -> call count
    this.maxStackDepth = 50;
    this.maxCallsPerUrl = 10;
    this.maxProcessingTime = 5000; // 5 seconds
    this.stackDepth = 0;
  }

  /**
   * Initialize safety guard
   * @param {Object} config - Configuration
   */
  init(config = {}) {
    this.maxStackDepth = config.maxStackDepth || 50;
    this.maxCallsPerUrl = config.maxCallsPerUrl || 10;
    this.maxProcessingTime = config.maxProcessingTime || 5000;
  }

  /**
   * Check if URL can be processed
   * @param {string} url - URL to check
   * @returns {boolean}
   */
  canProcess(url) {
    // Check if already processed (prevent re-processing)
    if (this.processed.has(url)) {
      return false;
    }

    // Check call count
    const callCount = this.callCounts.get(url) || 0;
    if (callCount >= this.maxCallsPerUrl) {
      this.logger.warn(`Max calls (${this.maxCallsPerUrl}) reached for: ${url}`);
      return false;
    }

    // Check if currently processing
    const processing = this.processing.get(url);
    if (processing) {
      const elapsed = Date.now() - processing.startTime;
      if (elapsed > this.maxProcessingTime) {
        this.logger.warn(`Processing timeout for: ${url}`);
        this.processing.delete(url);
        return false;
      }
      return false; // Already processing
    }

    return true;
  }

  /**
   * Start processing a URL
   * @param {string} url - URL
   */
  startProcessing(url) {
    this.processing.set(url, {
      startTime: Date.now(),
      stackDepth: this.stackDepth
    });

    const callCount = this.callCounts.get(url) || 0;
    this.callCounts.set(url, callCount + 1);
    this.stackDepth++;
  }

  /**
   * Finish processing a URL
   * @param {string} url - URL
   */
  finishProcessing(url) {
    this.processing.delete(url);
    this.stackDepth = Math.max(0, this.stackDepth - 1);
  }

  /**
   * Mark URL as successfully processed
   * @param {string} url - URL
   */
  markProcessed(url) {
    this.processed.add(url);
    this.finishProcessing(url);
  }

  /**
   * Check stack depth
   * @returns {boolean}
   */
  checkStackDepth() {
    if (this.stackDepth >= this.maxStackDepth) {
      this.logger.warn(`Max stack depth (${this.maxStackDepth}) reached`);
      return false;
    }
    return true;
  }

  /**
   * Reset processing state for a URL
   * @param {string} url - URL
   */
  reset(url = null) {
    if (url) {
      this.processing.delete(url);
      this.processed.delete(url);
      this.callCounts.delete(url);
    } else {
      this.processing.clear();
      this.processed.clear();
      this.callCounts.clear();
      this.stackDepth = 0;
    }
  }

  /**
   * Get processing stats
   * @returns {Object}
   */
  getStats() {
    return {
      processing: this.processing.size,
      processed: this.processed.size,
      stackDepth: this.stackDepth,
      maxStackDepth: this.maxStackDepth,
      maxCallsPerUrl: this.maxCallsPerUrl
    };
  }
}

export default SafetyGuard;



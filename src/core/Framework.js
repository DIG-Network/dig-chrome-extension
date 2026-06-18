/**
 * DIG Protocol Handler Framework
 * Core framework that prevents short-circuiting and manages interceptors
 * 
 * @module Framework
 */

import InterceptorRegistry from './InterceptorRegistry.js';
import StateManager from './StateManager.js';
import EventBus from './EventBus.js';
import SafetyGuard from '../utils/SafetyGuard.js';
import Logger from '../utils/Logger.js';

class Framework {
  constructor() {
    this.registry = new InterceptorRegistry();
    this.state = new StateManager();
    this.events = new EventBus();
    this.safety = new SafetyGuard();
    this.logger = new Logger('Framework');
    this.initialized = false;
    this.processing = new Set(); // Track URLs being processed
    this.interceptorStack = []; // Track interceptor call stack
  }

  /**
   * Initialize the framework
   * @param {Object} config - Configuration object
   */
  async init(config = {}) {
    if (this.initialized) {
      this.logger.warn('Framework already initialized');
      return;
    }

    // Load configuration
    await this.state.load(config);
    
    // Initialize safety guard
    this.safety.init({
      maxStackDepth: config.maxStackDepth || 50,
      maxCallsPerUrl: config.maxCallsPerUrl || 10,
      maxProcessingTime: config.maxProcessingTime || 5000
    });

    this.initialized = true;
    this.logger.info('Framework initialized');
    this.events.emit('framework:initialized', { config });
  }

  /**
   * Register an interceptor
   * @param {string} name - Interceptor name
   * @param {Function} interceptor - Interceptor function
   * @param {Object} options - Interceptor options
   */
  register(name, interceptor, options = {}) {
    if (!this.initialized) {
      throw new Error('Framework not initialized. Call init() first.');
    }

    // Safety check: prevent circular dependencies
    if (this.interceptorStack.includes(name)) {
      this.logger.error(`Circular dependency detected: ${this.interceptorStack.join(' -> ')} -> ${name}`);
      return false;
    }

    this.interceptorStack.push(name);
    try {
      const result = this.registry.register(name, interceptor, options);
      this.logger.info(`Interceptor registered: ${name}`);
      this.events.emit('interceptor:registered', { name, options });
      return result;
    } finally {
      this.interceptorStack.pop();
    }
  }

  /**
   * Process a dig:// URL through the interceptor chain
   * @param {string} url - URL to process
   * @param {Object} context - Processing context
   * @returns {Promise<Object>}
   */
  async processUrl(url, context = {}) {
    // Safety checks
    if (!this.safety.canProcess(url)) {
      return {
        processed: false,
        reason: 'safety_check_failed',
        url
      };
    }

    // Prevent recursive processing
    if (this.processing.has(url)) {
      this.logger.warn(`URL already being processed: ${url}`);
      return {
        processed: false,
        reason: 'already_processing',
        url
      };
    }

    this.processing.add(url);
    this.safety.startProcessing(url);

    try {
      // Get interceptors in priority order
      const interceptors = this.registry.getInterceptors();
      
      // Try each interceptor
      for (const interceptor of interceptors) {
        try {
          // Safety check before each interceptor
          if (!this.safety.checkStackDepth()) {
            this.logger.warn('Max stack depth reached');
            break;
          }

          const result = await interceptor.handler(url, context, this);
          
          if (result && result.processed) {
            this.logger.debug(`URL processed by ${interceptor.name}: ${url}`);
            this.safety.markProcessed(url);
            return {
              processed: true,
              interceptor: interceptor.name,
              result,
              url
            };
          }
        } catch (error) {
          this.logger.error(`Interceptor ${interceptor.name} failed:`, error);
          // Continue to next interceptor
        }
      }

      return {
        processed: false,
        reason: 'no_interceptor_handled',
        url
      };
    } finally {
      this.processing.delete(url);
      this.safety.finishProcessing(url);
    }
  }

  /**
   * Convert dig:// URL to configured server URL
   * @param {string} url - URL to convert
   * @param {number} port - Optional port override
   * @returns {string}
   */
  convertUrl(url, port = null) {
    if (typeof url !== 'string' || !url.startsWith('dig://')) {
      return url;
    }

    const serverUrl = this.state.get('server.url') || 'http://localhost';
    const serverPort = port || this.state.get('server.port') || 8080;
    const urlPath = url.replace(/^dig:\/\//, '');
    
    // Handle different server URL formats
    let baseUrl = serverUrl;
    if (!baseUrl.includes('://')) {
      baseUrl = `http://${baseUrl}`;
    }
    
    // Remove trailing slash from base URL
    baseUrl = baseUrl.replace(/\/$/, '');
    
    return `${baseUrl}:${serverPort}/${urlPath}`;
  }

  /**
   * Get framework state
   * @returns {Object}
   */
  getState() {
    return this.state.getAll();
  }

  /**
   * Update configuration
   * @param {Object} updates - Configuration updates
   */
  async updateConfig(updates) {
    await this.state.update(updates);
    this.events.emit('config:updated', { updates });
  }

  /**
   * Reset to defaults
   */
  async resetDefaults() {
    await this.state.reset();
    this.events.emit('config:reset');
  }
}

// Export singleton instance
const framework = new Framework();
export default framework;



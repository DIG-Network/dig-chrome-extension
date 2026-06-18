/**
 * Interceptor Registry
 * Manages interceptors and prevents circular dependencies
 * 
 * @module InterceptorRegistry
 */

import Logger from '../utils/Logger.js';

class InterceptorRegistry {
  constructor() {
    this.interceptors = new Map();
    this.priorities = new Map();
    this.dependencies = new Map();
    this.logger = new Logger('InterceptorRegistry');
  }

  /**
   * Register an interceptor
   * @param {string} name - Interceptor name
   * @param {Function} handler - Handler function
   * @param {Object} options - Options
   * @param {number} options.priority - Priority (higher = first)
   * @param {Array<string>} options.dependsOn - Dependencies
   * @param {boolean} options.once - Only run once per URL
   */
  register(name, handler, options = {}) {
    if (this.interceptors.has(name)) {
      this.logger.warn(`Interceptor ${name} already registered, replacing`);
    }

    const priority = options.priority || 0;
    const dependsOn = options.dependsOn || [];
    const once = options.once || false;

    // Check for circular dependencies
    if (this.hasCircularDependency(name, dependsOn)) {
      this.logger.error(`Circular dependency detected for ${name}`);
      return false;
    }

    this.interceptors.set(name, {
      name,
      handler,
      priority,
      dependsOn,
      once,
      processed: new Set() // Track processed URLs if once=true
    });

    this.priorities.set(name, priority);
    this.dependencies.set(name, dependsOn);

    return true;
  }

  /**
   * Check for circular dependencies
   * @param {string} name - Interceptor name
   * @param {Array<string>} dependsOn - Dependencies
   * @returns {boolean}
   */
  hasCircularDependency(name, dependsOn) {
    const visited = new Set();
    const visiting = new Set();

    const visit = (node) => {
      if (visiting.has(node)) {
        return true; // Circular dependency found
      }
      if (visited.has(node)) {
        return false;
      }

      visiting.add(node);
      const deps = this.dependencies.get(node) || [];
      for (const dep of deps) {
        if (visit(dep)) {
          return true;
        }
      }
      visiting.delete(node);
      visited.add(node);
      return false;
    };

    return visit(name);
  }

  /**
   * Get interceptors in priority order
   * @returns {Array}
   */
  getInterceptors() {
    const sorted = Array.from(this.interceptors.values())
      .sort((a, b) => {
        // Sort by priority (higher first)
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        // Then by name for consistency
        return a.name.localeCompare(b.name);
      });

    return sorted;
  }

  /**
   * Check if URL was already processed by a "once" interceptor
   * @param {string} name - Interceptor name
   * @param {string} url - URL
   * @returns {boolean}
   */
  wasProcessed(name, url) {
    const interceptor = this.interceptors.get(name);
    if (!interceptor || !interceptor.once) {
      return false;
    }
    return interceptor.processed.has(url);
  }

  /**
   * Mark URL as processed by interceptor
   * @param {string} name - Interceptor name
   * @param {string} url - URL
   */
  markProcessed(name, url) {
    const interceptor = this.interceptors.get(name);
    if (interceptor && interceptor.once) {
      interceptor.processed.add(url);
    }
  }

  /**
   * Clear processed cache
   * @param {string} name - Optional interceptor name
   */
  clearCache(name = null) {
    if (name) {
      const interceptor = this.interceptors.get(name);
      if (interceptor) {
        interceptor.processed.clear();
      }
    } else {
      this.interceptors.forEach(interceptor => {
        interceptor.processed.clear();
      });
    }
  }

  /**
   * Unregister an interceptor
   * @param {string} name - Interceptor name
   */
  unregister(name) {
    this.interceptors.delete(name);
    this.priorities.delete(name);
    this.dependencies.delete(name);
  }

  /**
   * Get interceptor count
   * @returns {number}
   */
  getCount() {
    return this.interceptors.size;
  }
}

export default InterceptorRegistry;



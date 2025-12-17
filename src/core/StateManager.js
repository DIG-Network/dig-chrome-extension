/**
 * State Manager
 * Manages application state and configuration
 * 
 * @module StateManager
 */

import Logger from '../utils/Logger.js';

class StateManager {
  constructor() {
    this.state = new Map();
    this.defaults = new Map();
    this.listeners = new Map();
    this.logger = new Logger('StateManager');
  }

  /**
   * Load initial state
   * @param {Object} config - Configuration object
   */
  async load(config = {}) {
    // Set defaults
    this.defaults.set('server.url', 'localhost');
    this.defaults.set('server.port', 8080);
    this.defaults.set('extension.enabled', true);
    this.defaults.set('logging.level', 'info');
    this.defaults.set('safety.maxStackDepth', 50);
    this.defaults.set('safety.maxCallsPerUrl', 10);

    // Load from storage if available
    if (typeof chrome !== 'undefined' && chrome.storage) {
      try {
        const stored = await chrome.storage.local.get(null);
        Object.entries(stored).forEach(([key, value]) => {
          this.state.set(key, value);
        });
      } catch (error) {
        this.logger.warn('Failed to load from storage:', error);
      }
    }

    // Merge with provided config
    this._mergeConfig(config);

    // Initialize with defaults for missing values
    this.defaults.forEach((value, key) => {
      if (!this.state.has(key)) {
        this.state.set(key, value);
      }
    });
  }

  /**
   * Merge configuration object into state
   * @param {Object} config - Configuration
   * @private
   */
  _mergeConfig(config) {
    const merge = (obj, prefix = '') => {
      Object.entries(obj).forEach(([key, value]) => {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          merge(value, fullKey);
        } else {
          this.state.set(fullKey, value);
        }
      });
    };

    merge(config);
  }

  /**
   * Get a state value
   * @param {string} key - State key (supports dot notation)
   * @param {*} defaultValue - Default value
   * @returns {*}
   */
  get(key, defaultValue = undefined) {
    if (this.state.has(key)) {
      return this.state.get(key);
    }
    return defaultValue !== undefined ? defaultValue : this.defaults.get(key);
  }

  /**
   * Set a state value
   * @param {string} key - State key
   * @param {*} value - Value
   * @param {boolean} persist - Persist to storage
   */
  async set(key, value, persist = true) {
    const oldValue = this.state.get(key);
    this.state.set(key, value);

    // Persist to storage
    if (persist && typeof chrome !== 'undefined' && chrome.storage) {
      try {
        await chrome.storage.local.set({ [key]: value });
      } catch (error) {
        this.logger.warn(`Failed to persist ${key}:`, error);
      }
    }

    // Notify listeners
    this._notifyListeners(key, value, oldValue);
  }

  /**
   * Update multiple state values
   * @param {Object} updates - Updates object
   */
  async update(updates) {
    const promises = Object.entries(updates).map(([key, value]) => {
      return this.set(key, value);
    });
    await Promise.all(promises);
  }

  /**
   * Reset to defaults
   */
  async reset() {
    this.defaults.forEach((value, key) => {
      this.state.set(key, value);
    });

    if (typeof chrome !== 'undefined' && chrome.storage) {
      try {
        const resetData = {};
        this.defaults.forEach((value, key) => {
          resetData[key] = value;
        });
        await chrome.storage.local.set(resetData);
      } catch (error) {
        this.logger.warn('Failed to reset storage:', error);
      }
    }

    // Notify all listeners
    this.defaults.forEach((value, key) => {
      this._notifyListeners(key, value, this.state.get(key));
    });
  }

  /**
   * Get all state
   * @returns {Object}
   */
  getAll() {
    const result = {};
    this.state.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  /**
   * Subscribe to state changes
   * @param {string} key - State key
   * @param {Function} callback - Callback function
   * @returns {Function} Unsubscribe function
   */
  subscribe(key, callback) {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key).add(callback);

    return () => {
      const callbacks = this.listeners.get(key);
      if (callbacks) {
        callbacks.delete(callback);
      }
    };
  }

  /**
   * Notify listeners of state change
   * @param {string} key - State key
   * @param {*} newValue - New value
   * @param {*} oldValue - Old value
   * @private
   */
  _notifyListeners(key, newValue, oldValue) {
    const callbacks = this.listeners.get(key);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(newValue, oldValue, key);
        } catch (error) {
          this.logger.error(`Listener error for ${key}:`, error);
        }
      });
    }
  }
}

export default StateManager;


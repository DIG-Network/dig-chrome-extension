/**
 * Event Bus
 * Centralized event system
 * 
 * @module EventBus
 */

import Logger from '../utils/Logger.js';

class EventBus {
  constructor() {
    this.listeners = new Map();
    this.logger = new Logger('EventBus');
    this.maxListeners = 100;
  }

  /**
   * Subscribe to an event
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   * @returns {Function} Unsubscribe function
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    const callbacks = this.listeners.get(event);
    if (callbacks.size >= this.maxListeners) {
      this.logger.warn(`Max listeners (${this.maxListeners}) reached for event: ${event}`);
      return () => {};
    }

    callbacks.add(callback);

    return () => {
      const callbacks = this.listeners.get(event);
      if (callbacks) {
        callbacks.delete(callback);
      }
    };
  }

  /**
   * Subscribe to an event once
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   * @returns {Function} Unsubscribe function
   */
  once(event, callback) {
    const wrapper = (...args) => {
      callback(...args);
      unsubscribe();
    };
    const unsubscribe = this.on(event, wrapper);
    return unsubscribe;
  }

  /**
   * Emit an event
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  emit(event, data = {}) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          this.logger.error(`Error in event listener for ${event}:`, error);
        }
      });
    }
  }

  /**
   * Remove all listeners for an event
   * @param {string} event - Event name
   */
  off(event) {
    this.listeners.delete(event);
  }

  /**
   * Remove all listeners
   */
  clear() {
    this.listeners.clear();
  }

  /**
   * Get listener count for an event
   * @param {string} event - Event name
   * @returns {number}
   */
  listenerCount(event) {
    const callbacks = this.listeners.get(event);
    return callbacks ? callbacks.size : 0;
  }
}

export default EventBus;



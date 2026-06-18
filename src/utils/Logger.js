/**
 * Logger
 * Centralized logging system
 * 
 * @module Logger
 */

class Logger {
  constructor(module = 'App') {
    this.module = module;
    this.enabled = true;
    this.level = 'info';
    this.levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };
  }

  /**
   * Set log level
   * @param {string} level - Log level
   */
  setLevel(level) {
    if (this.levels.hasOwnProperty(level)) {
      this.level = level;
    }
  }

  /**
   * Enable logging
   */
  enable() {
    this.enabled = true;
  }

  /**
   * Disable logging
   */
  disable() {
    this.enabled = false;
  }

  /**
   * Log a message
   * @param {string} level - Log level
   * @param {Array} args - Arguments
   * @private
   */
  _log(level, ...args) {
    if (!this.enabled) return;
    if (this.levels[level] < this.levels[this.level]) return;

    const prefix = `[${this.module}]`;
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    
    console[method](prefix, ...args);
  }

  debug(...args) {
    this._log('debug', ...args);
  }

  info(...args) {
    this._log('info', ...args);
  }

  warn(...args) {
    this._log('warn', ...args);
  }

  error(...args) {
    this._log('error', ...args);
  }
}

export default Logger;



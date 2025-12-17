/**
 * Default Configuration
 * 
 * @module Config
 */

export default {
  // Server configuration
  server: {
    url: 'localhost',
    port: 8080
  },

  // Extension settings
  extension: {
    enabled: true
  },

  // Logging
  logging: {
    enabled: true,
    level: 'info' // debug, info, warn, error
  },

  // Safety settings
  safety: {
    maxStackDepth: 50,
    maxCallsPerUrl: 10,
    maxProcessingTime: 5000 // milliseconds
  }
};


# DIG Protocol Handler - Architecture

## Overview

This is the most advanced `dig://` protocol handler browser extension, built with a professional framework architecture that prevents short-circuiting, infinite loops, and circular dependencies.

## Architecture Principles

### 1. Framework-Based Design
- **Core Framework**: Central orchestration layer
- **Interceptor Registry**: Manages all URL interceptors
- **State Manager**: Centralized configuration and state
- **Event Bus**: Decoupled event system
- **Safety Guard**: Prevents infinite loops and recursion

### 2. Safety Mechanisms

#### Short-Circuit Prevention
- **Processing Tracking**: Tracks URLs currently being processed
- **Stack Depth Monitoring**: Prevents deep recursion
- **Call Count Limits**: Limits processing attempts per URL
- **Timeout Protection**: Prevents hanging processes

#### Circular Dependency Prevention
- **Dependency Graph**: Tracks interceptor dependencies
- **Cycle Detection**: Detects circular dependencies at registration
- **Stack Tracking**: Monitors interceptor call stack

### 3. Modular Structure

```
src/
├── core/                    # Core framework
│   ├── Framework.js         # Main framework orchestrator
│   ├── InterceptorRegistry.js  # Interceptor management
│   ├── StateManager.js      # State and configuration
│   └── EventBus.js          # Event system
├── utils/                   # Utilities
│   ├── SafetyGuard.js       # Safety mechanisms
│   └── Logger.js            # Logging system
├── interceptors/            # URL interceptors
│   ├── HTMLInterceptor.js
│   ├── CSSInterceptor.js
│   ├── JSAPIInterceptor.js
│   └── NavigationInterceptor.js
└── config/                  # Configuration
    └── default.js           # Default settings
```

## Core Components

### Framework (`src/core/Framework.js`)
- Main entry point for all operations
- Manages interceptor chain execution
- Prevents recursive processing
- Handles URL conversion

### InterceptorRegistry (`src/core/InterceptorRegistry.js`)
- Registers and manages interceptors
- Prevents circular dependencies
- Prioritizes interceptor execution
- Tracks processed URLs

### StateManager (`src/core/StateManager.js`)
- Manages application state
- Persists to Chrome storage
- Provides reactive updates
- Handles configuration

### SafetyGuard (`src/utils/SafetyGuard.js`)
- Prevents infinite loops
- Monitors stack depth
- Tracks processing state
- Enforces timeouts

## Configuration

### Server Configuration
- **URL**: Configurable server URL (default: `localhost`)
- **Port**: Configurable port (default: `8080`)
- **UI**: Popup interface with restore default button
- **Persistence**: Saved to Chrome storage

### Safety Configuration
- **Max Stack Depth**: 50 (configurable)
- **Max Calls Per URL**: 10 (configurable)
- **Max Processing Time**: 5000ms (configurable)

## Interceptor System

### Registration
```javascript
framework.register('myInterceptor', async (url, context, framework) => {
  // Process URL
  return { processed: true, result: ... };
}, {
  priority: 10,
  dependsOn: ['otherInterceptor'],
  once: false
});
```

### Execution Flow
1. Safety checks (can process?)
2. Interceptor chain execution (priority order)
3. First successful interceptor wins
4. Safety cleanup

## State Management

### Configuration Keys
- `server.url`: Server URL
- `server.port`: Server port
- `extension.enabled`: Extension enabled state
- `logging.level`: Log level
- `safety.*`: Safety settings

### State Updates
- Reactive: Listeners notified on changes
- Persistent: Saved to Chrome storage
- Defaults: Fallback to defaults if missing

## Event System

### Events
- `framework:initialized`: Framework ready
- `interceptor:registered`: New interceptor
- `config:updated`: Configuration changed
- `config:reset`: Reset to defaults

### Usage
```javascript
framework.events.on('config:updated', ({ updates }) => {
  // Handle config update
});
```

## Safety Features

### 1. Processing Lock
- URLs being processed are locked
- Prevents concurrent processing
- Automatic timeout release

### 2. Stack Depth Protection
- Monitors call stack depth
- Prevents deep recursion
- Configurable limit

### 3. Call Count Limits
- Tracks attempts per URL
- Prevents infinite retries
- Configurable threshold

### 4. Timeout Protection
- Maximum processing time
- Automatic cleanup
- Prevents hanging

## Performance Optimizations

### 1. Interceptor Prioritization
- High priority interceptors run first
- Early exit on success
- Efficient chain execution

### 2. Caching
- Processed URL tracking
- Prevents re-processing
- Memory efficient

### 3. Lazy Loading
- Interceptors loaded on demand
- Minimal initialization overhead
- Fast startup

## Build System

### Bundling
- ES6 modules → Single bundle
- Tree shaking
- Minification
- Source maps

### Output
- `dist/` directory
- Optimized for production
- Compatible with Manifest V3

## Usage

### Initialization
```javascript
import framework from './core/Framework.js';

await framework.init({
  server: { url: 'localhost', port: 8080 },
  safety: { maxStackDepth: 50 }
});
```

### Processing URLs
```javascript
const result = await framework.processUrl('dig://example.com/resource');
```

### Configuration
```javascript
// Update server URL
await framework.updateConfig({
  'server.url': 'example.com',
  'server.port': 3000
});

// Reset to defaults
await framework.resetDefaults();
```

## Best Practices

1. **Always use framework methods** - Don't bypass the framework
2. **Register interceptors early** - During initialization
3. **Use safety checks** - Before processing
4. **Handle errors gracefully** - Don't break the chain
5. **Monitor performance** - Use logger and events

## Future Enhancements

- [ ] Web Worker support
- [ ] Service Worker integration
- [ ] Advanced caching strategies
- [ ] Performance metrics
- [ ] Developer tools integration



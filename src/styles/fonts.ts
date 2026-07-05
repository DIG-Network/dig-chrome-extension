/**
 * Vendored display + mono type for the DIG product theme — Space Grotesk (display) + Space Mono
 * (numbers/technical), both OFL, shipped IN-PACKAGE via @fontsource so they load under the MV3
 * extension-page CSP (`font-src 'self'`) with no remote fetch and no font-pop. Only the latin
 * subset + the weights the UI uses are imported to keep the bundle small; Vite emits the woff2 as
 * `'self'` assets that build.js copies into dist/.
 */
import '@fontsource/space-grotesk/latin-400.css';
import '@fontsource/space-grotesk/latin-500.css';
import '@fontsource/space-grotesk/latin-700.css';
import '@fontsource/space-mono/latin-400.css';
import '@fontsource/space-mono/latin-700.css';

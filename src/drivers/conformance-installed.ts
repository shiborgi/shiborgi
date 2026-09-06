/**
 * The barrel overlay drivers append their conformance harness to — one
 * appended `import './x.js';` and one `registerConformanceHarness(...)` call in
 * the imported file, the same shape as `installed.ts`. Nothing outside this
 * directory is rewritten to put a driver on the conformance floor.
 */

import './apple-container-conformance.js';

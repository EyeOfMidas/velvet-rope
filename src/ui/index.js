// velvet-rope/ui: drop-in components. Every string can be replaced through `text`, and every
// class name through `classes`, so an app can match its own look; ui/style.css styles the
// default vr-* classes. For a fully custom UI, use velvet-rope/client instead.
export { mountJoin, JOIN_TEXT, JOIN_CLASSES } from './join.js';
export { createScanButton, mountScanButton, SCAN_BUTTON_TEXT } from './scan-button.js';
export { openScanner, SCANNER_TEXT, SCANNER_CLASSES } from './scanner.js';

// A friendly default label for this browser's passkey, e.g. "Firefox on Windows" (plan §4.1).
// Order matters: Edge and many others also say "Chrome"; Chrome also says "Safari".
const BROWSERS = [
  [/FxiOS|Firefox\//, 'Firefox'],
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/CriOS|Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const PLATFORMS = [
  [/Android/, 'Android'],
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'Mac'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

const match = (list, ua) => list.find(([re]) => re.test(ua))?.[1];

export function labelFromUserAgent(ua) {
  const browser = match(BROWSERS, ua);
  const platform = match(PLATFORMS, ua);
  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? platform ?? 'This device';
}

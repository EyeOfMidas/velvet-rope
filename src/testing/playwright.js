// Playwright helpers for end-to-end tests of an app using velvet-rope, in Chromium (they use the
// Chrome DevTools Protocol's virtual authenticator). They take pages and browsers from the test,
// so this module doesn't import Playwright itself.

/** Gives the page's browser context a platform authenticator that holds discoverable passkeys. */
export async function addVirtualAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  return cdp;
}

/**
 * Two devices, each its own browser context with its own authenticator: a phone-sized one and
 * a desktop. Returns { phone, desktop, close }.
 */
export async function twoDevices(browser) {
  const phoneContext = await browser.newContext({ viewport: { width: 412, height: 900 } });
  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const phone = await phoneContext.newPage();
  const desktop = await desktopContext.newPage();
  await addVirtualAuthenticator(phone);
  await addVirtualAuthenticator(desktop);
  const close = async () => {
    await phoneContext.close();
    await desktopContext.close();
  };
  return { phone, desktop, close };
}

/**
 * Links `joiner` to the group `scanner` is signed in to, through mountJoin: `openJoin(joiner)`
 * gets the joiner to the join form (e.g. clicks the app's "Join" button), then this names the
 * passkey `label`, shows the code, and has the scanner open the join link, which is what a scan
 * does. Returns the link. Pass `text` if the app renamed mountJoin's field or button.
 */
export async function linkDevice({ joiner, scanner, label, openJoin, text = {} }) {
  const { labelField = 'Name this passkey', showCode = 'Show QR code' } = text;
  await openJoin(joiner);
  await joiner.getByLabel(labelField).fill(label);
  await joiner.getByRole('button', { name: showCode }).click();
  const url = await joiner.getByTestId('link-url').inputValue();
  await scanner.goto(url);
  return url;
}

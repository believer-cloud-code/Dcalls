/** Shared user-safe error messages. */
export function getFriendlyErrorMessage(error: unknown, fallback = 'Something went wrong. Please try again. If the problem continues, contact support.'): string {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code.toLowerCase() : '';
  const message = typeof candidate?.message === 'string' ? candidate.message : typeof error === 'string' ? error : '';
  const text = `${code} ${message}`.toLowerCase();
  if (/device.{0,40}(revoked|removed)|(?:revoked|removed).{0,40}device/.test(text)) return 'This device has been removed from the account and can no longer connect. Start a new pairing from a trusted device.';
  if (['auth/invalid-credential','auth/wrong-password','auth/user-not-found'].includes(code)) return 'The email or password is incorrect. Check your details and try again.';
  if (code === 'auth/invalid-email') return 'Enter a valid email address and try again.';
  if (code === 'auth/email-already-in-use') return 'An account already exists with this email address. Sign in instead.';
  if (code === 'auth/weak-password') return 'Choose a stronger password with at least the required number of characters.';
  if (code === 'auth/too-many-requests') return 'There have been too many attempts. Wait a little while before trying again.';
  if (code === 'auth/network-request-failed') return 'Dcalls could not reach the sign-in service. Check your internet connection and try again.';
  if (code === 'auth/popup-closed-by-user') return 'The sign-in window was closed before sign-in finished. Try again when you are ready.';
  if (code === 'auth/user-disabled') return 'This account has been disabled. Contact support for help.';
  if (code === 'unauthenticated') return 'Your sign-in has expired. Sign in again and retry.';
  if (code === 'permission-denied' || code === 'storage/unauthorized' || /missing or insufficient permissions/.test(text)) return 'You do not have permission to complete this action. Refresh Dcalls and try again. If it continues, contact support.';
  if (code === 'unavailable' || code === 'deadline-exceeded' || /client is offline|network request failed|failed to fetch|networkerror/.test(text)) return 'Dcalls could not reach the service. Check your connection and try again.';
  if (code === 'resource-exhausted') return 'This service is temporarily busy. Wait a moment and try again.';
  if (code === 'not-found') return 'The item you requested is no longer available. Refresh and try again.';
  if (code === 'already-exists') return 'This item already exists. Refresh the page to see the latest state.';
  if (/not a valid dcalls device-link qr|qr code is malformed|unsupported/.test(text)) return 'This QR code is not valid or is from an unsupported version. Scan a fresh Dcalls pairing code.';
  if (/camera|getusermedia|media device/.test(text)) return 'Dcalls could not access your camera. Allow camera access in your browser settings, or paste the QR text instead.';
  if (/expired/.test(text)) return 'This pairing session has expired. Create a new QR code and try again.';
  const technical = /firebaseerror|firestore|permission-denied|internal error|\btypeerror\b|\breferenceerror\b|cannot read propert|undefined is not|\bat [\w./-]+ \(/i;
  if (message && !technical.test(message) && message.length <= 240) return message;
  return fallback;
}

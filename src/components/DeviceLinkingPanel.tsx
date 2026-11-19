import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Camera, CheckCircle2, Copy, Link2, Loader2, RefreshCw, ShieldCheck, Smartphone, XCircle } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { matrixCryptoService } from '../services/matrixCryptoService';
import { qrDeviceLinkService } from '../services/qrDeviceLinkService';
import { deviceRegistryService } from '../services/deviceRegistryService';
import { getFriendlyErrorMessage } from '../utils/errorMessages';

interface DeviceLinkingPanelProps {
  userId: string;
}

type PairingMode = 'display' | 'scan';

type BarcodeDetectorLike = {
  detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>;
};

type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike;

export const DeviceLinkingPanel: React.FC<DeviceLinkingPanelProps> = ({ userId }) => {
  const [mode, setMode] = useState<PairingMode>('display');
  const [deviceId, setDeviceId] = useState('');
  const [qrPayload, setQrPayload] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [qrInput, setQrInput] = useState('');
  const [status, setStatus] = useState('No active pairing session');
  const [verificationCode, setVerificationCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [bundleSent, setBundleSent] = useState(false);
  const [bundleReceived, setBundleReceived] = useState(false);
  const [receiptVerified, setReceiptVerified] = useState(false);
  const [sourceAccepted, setSourceAccepted] = useState(false);
  const [joinInfo, setJoinInfo] = useState<{ deviceId: string; deviceName: string } | null>(null);
  const [scannerCompleted, setScannerCompleted] = useState(false);
  const [sourceVerified, setSourceVerified] = useState(false);
  const [scannerCodeConfirmed, setScannerCodeConfirmed] = useState(false);
  const [registeredDevices, setRegisteredDevices] = useState<Array<{ id: string; deviceKeys?: Record<string, unknown>; revokedAt?: unknown; updatedAt?: unknown; linkedAt?: unknown; linkedFromDeviceId?: string; linkSessionId?: string }>>([]);
  const [pendingRevocationId, setPendingRevocationId] = useState<string | null>(null);
  const [linkComplete, setLinkComplete] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let active = true;
    matrixCryptoService.getDeviceId(userId)
      .then((id) => { if (active) setDeviceId(id); })
      .catch((reason) => { if (active) setError(getFriendlyErrorMessage(reason, 'Dcalls could not load this device identity. Refresh and try again.')); });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    if (!cameraActive) return;
    let active = true;
    let stream: MediaStream | null = null;
    let frame = 0;
    const video = videoRef.current;
    const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;

    if (!Detector) {
      setError('QR camera scanning is not available in this browser. Paste the QR text below instead.');
      setCameraActive(false);
      return;
    }

    const detector = new Detector({ formats: ['qr_code'] });
    const scan = async () => {
      if (!active || !video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        if (active) frame = requestAnimationFrame(scan);
        return;
      }
      try {
        const results = await detector.detect(video);
        const value = results[0]?.rawValue;
        if (value) {
          setQrInput(value);
          setCameraActive(false);
          return;
        }
      } catch (reason) {
        setError(getFriendlyErrorMessage(reason, 'Dcalls could not read the QR code. Try again or paste the QR text.'));
      }
      if (active) frame = requestAnimationFrame(scan);
    };

    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(async (media) => {
        if (!active) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        if (video) {
          video.srcObject = media;
          await video.play();
          frame = requestAnimationFrame(scan);
        }
      })
      .catch((reason) => {
        setError(getFriendlyErrorMessage(reason, 'Dcalls could not access your camera. Allow camera access or paste the QR text.'));
        setCameraActive(false);
      });

    return () => {
      active = false;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
    };
  }, [cameraActive]);

  const refreshRegisteredDevices = async () => {
    const devices = await deviceRegistryService.listAllDevices(userId);
    setRegisteredDevices(devices);
  };

  useEffect(() => {
    if (!deviceId) return;
    let active = true;
    deviceRegistryService.listAllDevices(userId)
      .then((devices) => { if (active) setRegisteredDevices(devices); })
      .catch((reason) => { if (active) setError(getFriendlyErrorMessage(reason, 'Dcalls could not load your devices. Refresh and try again.')); });
    return () => { active = false; };
  }, [userId, deviceId]);

  const revokeDevice = (targetDeviceId: string) => run(async () => {
    await deviceRegistryService.revokeDevice(userId, targetDeviceId);
    setPendingRevocationId(null);
    await refreshRegisteredDevices();
  });

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      setError(getFriendlyErrorMessage(reason, 'Dcalls could not complete that action. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const createQr = () => run(async () => {
    if (!userId || !deviceId) throw new Error('Your device identity is not ready yet.');
    await matrixCryptoService.publishInitialDeviceKeys(userId);
    await matrixCryptoService.bootstrapCrossSigning(userId);
    const created = await qrDeviceLinkService.createSession(userId, deviceId);
    setSessionId(created.sessionId);
    setQrPayload(created.qrPayload);
    setExpiresAt(created.expiresAt);
    setVerificationCode('');
    setBundleSent(false);
    setReceiptVerified(false);
    setSourceAccepted(false);
    setJoinInfo(null);
    setSourceVerified(false);
    setLinkComplete(false);
    setStatus('Pairing code ready. Scan it using your new Dcalls device.');
  });

  const inspectJoin = () => run(async () => {
    if (!sessionId) throw new Error('Create a QR session first.');
    const info = await qrDeviceLinkService.inspectJoin(userId, sessionId);
    setJoinInfo(info);
    setStatus('Review the requesting device before approving the pairing.');
  });

  const acceptJoin = () => run(async () => {
    if (!sessionId) throw new Error('Create a QR session first.');
    const code = await qrDeviceLinkService.acceptJoin(userId, sessionId);
    setVerificationCode(code);
    setSourceAccepted(true);
    setStatus('New device accepted. Compare the verification code on both devices.');
  });

  const verifySource = () => run(async () => {
    if (!sessionId) throw new Error('No active pairing session.');
    const code = await qrDeviceLinkService.verifySourceCompletion(userId, sessionId);
    setVerificationCode(code);
    setSourceVerified(true);
    setStatus('Secure channel verified. Account signing-key transfer is ready.');
  });

  const joinQr = () => run(async () => {
    if (!userId || !deviceId || !qrInput.trim()) throw new Error('Paste or scan the QR code first.');
    await matrixCryptoService.publishInitialDeviceKeys(userId);
    const joined = await qrDeviceLinkService.joinSession(userId, deviceId, qrInput.trim());
    setSessionId(joined);
    setLinkComplete(false);
    setQrInput('');
    setVerificationCode('');
    setScannerCompleted(false);
    setScannerCodeConfirmed(false);
    setBundleReceived(false);
    setStatus('Pairing request sent. Approve it on the device displaying the QR code.');
  });

  const completeJoin = () => run(async () => {
    if (!sessionId) throw new Error('Scan a Dcalls pairing QR code first.');
    const code = await qrDeviceLinkService.completeJoin(userId, sessionId);
    setVerificationCode(code);
    setScannerCompleted(true);
    setScannerCodeConfirmed(false);
    setStatus('Secure channel established. Compare this code with the existing device.');
  });

  const sendAccountKeys = () => run(async () => {
    if (!sessionId) throw new Error('No verified pairing session is active.');
    const bundle = await matrixCryptoService.exportSecretsBundleForDeviceLink(userId);
    await qrDeviceLinkService.sendSecretsBundle(userId, sessionId, bundle);
    setBundleSent(true);
    setStatus('Encrypted account signing keys sent. Waiting for the new device to confirm import.');
  });

  const receiveAccountKeys = () => run(async () => {
    if (!sessionId) throw new Error('No verified pairing session is active.');
    const bundle = await qrDeviceLinkService.receiveSecretsBundle(userId, sessionId);
    await matrixCryptoService.importSecretsBundleFromDeviceLink(userId, bundle);
    await qrDeviceLinkService.acknowledgeSecretsBundle(userId, sessionId);
    await refreshRegisteredDevices();
    setBundleReceived(true);
    setStatus('Account signing keys imported. Waiting for the existing device to confirm that linking is complete.');
  });

  const clearPairingState = useCallback((message: string, completed = false) => {
    setSessionId('');
    setQrPayload('');
    setExpiresAt(null);
    setQrInput('');
    setVerificationCode('');
    setBundleSent(false);
    setBundleReceived(false);
    setReceiptVerified(false);
    setSourceAccepted(false);
    setJoinInfo(null);
    setScannerCompleted(false);
    setScannerCodeConfirmed(false);
    setSourceVerified(false);
    setCameraActive(false);
    setLinkComplete(completed);
    setStatus(message);
  }, []);

  const checkAccountKeysReceipt = () => run(async () => {
    if (!sessionId) throw new Error('No pairing session is active.');
    const received = await qrDeviceLinkService.verifySecretsBundleReceipt(userId, sessionId);
    if (!received) throw new Error('The new device has not confirmed the key import yet.');
    await qrDeviceLinkService.completeSecretsTransfer(userId, sessionId);
    await refreshRegisteredDevices();
    clearPairingState('Device linked successfully. The new device verified and acknowledged the encrypted account-key transfer.', true);
  });

  const confirmLinkCompletion = () => run(async () => {
    if (!sessionId) throw new Error('There is no active pairing session to check.');
    const completed = await qrDeviceLinkService.confirmCompletedSession(userId, sessionId);
    if (!completed) throw new Error('The existing device has not finished confirming this link yet. Keep both devices connected and check again.');
    await refreshRegisteredDevices();
    clearPairingState('This device is now linked. Your account signing keys were imported and the existing device confirmed the transfer.', true);
  });

  useEffect(() => {
    if (!sessionId || !bundleReceived || mode !== 'scan' || linkComplete) return;
    return qrDeviceLinkService.watchForCompletion(
      userId,
      sessionId,
      async () => {
        const devices = await deviceRegistryService.listAllDevices(userId);
        const completed = await qrDeviceLinkService.confirmCompletedSession(userId, sessionId);
        if (!completed) return;
        setRegisteredDevices(devices);
        clearPairingState('This device is now linked. Your account signing keys were imported and the existing device confirmed the transfer.', true);
      },
      (reason) => setError(getFriendlyErrorMessage(reason, 'Dcalls could not confirm that the device link finished. Check again in a moment.')),
    );
  }, [userId, sessionId, bundleReceived, mode, linkComplete, clearPairingState]);

  const cancel = () => run(async () => {
    if (sessionId) await qrDeviceLinkService.cancelSession(userId, sessionId);
    clearPairingState('Pairing cancelled.');
  });

  return (
    <div className="space-y-6 text-white">
      <div className="rounded-2xl border border-indigo-500/20 bg-indigo-500/5 p-4 space-y-2">
        <div className="flex items-center gap-2 text-indigo-300">
          <ShieldCheck size={18} />
          <h3 className="text-sm font-bold">Secure device pairing</h3>
        </div>
        <p className="text-xs leading-relaxed text-gray-400">
          Pair devices signed into the same Dcalls account. The QR handshake uses the Matrix SDK's HPKE channel and keeps its private channel state on the devices.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 rounded-xl bg-white/5 p-1">
        <button onClick={() => { setMode('display'); setError(''); }} className={`rounded-lg py-3 text-xs font-bold transition-colors ${mode === 'display' ? 'bg-indigo-600 text-white' : 'text-gray-400'}`}>
          Display QR
        </button>
        <button onClick={() => { setMode('scan'); setError(''); }} className={`rounded-lg py-3 text-xs font-bold transition-colors ${mode === 'scan' ? 'bg-indigo-600 text-white' : 'text-gray-400'}`}>
          Scan QR
        </button>
      </div>

      {mode === 'display' ? (
        <div className="space-y-4">
          {!qrPayload ? (
            <button disabled={busy || !deviceId} onClick={createQr} className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold disabled:opacity-50 flex items-center justify-center gap-2">
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
              Create pairing QR
            </button>
          ) : (
            <div className="rounded-2xl bg-white p-4 flex justify-center">
              <QRCodeSVG value={qrPayload} size={224} level="M" includeMargin />
            </div>
          )}
          {qrPayload && (
            <>
              <div className="text-center space-y-1">
                <p className="text-sm font-semibold">Scan with your new device</p>
                <p className="text-xs text-gray-500">Expires {expiresAt ? new Date(expiresAt).toLocaleTimeString() : 'soon'}</p>
              </div>
              <button onClick={() => run(async () => { await navigator.clipboard.writeText(qrPayload); })} className="w-full rounded-xl border border-white/10 py-3 text-xs font-semibold flex items-center justify-center gap-2">
                <Copy size={14} /> Copy pairing payload
              </button>
              {!joinInfo && !sourceAccepted && (
                <button disabled={busy} onClick={inspectJoin} className="w-full rounded-xl border border-white/10 py-3 text-xs font-bold disabled:opacity-50">
                  Check for new device
                </button>
              )}
              {joinInfo && !sourceAccepted && (
                <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-3 space-y-2">
                  <p className="text-[10px] uppercase tracking-widest text-indigo-300">Device requesting access</p>
                  <p className="text-xs font-semibold break-words">{joinInfo.deviceName}</p>
                  <p className="text-[9px] text-gray-500 break-all">Device ID: {joinInfo.deviceId}</p>
                  <p className="text-[10px] leading-relaxed text-amber-300">The client label is self-reported, not proof of identity. Only approve after comparing the verification code on both devices.</p>
                  <button disabled={busy} onClick={acceptJoin} className="w-full rounded-xl bg-indigo-600 py-3 text-xs font-bold disabled:opacity-50">
                    Approve this device
                  </button>
                </div>
              )}
              {verificationCode && (
                <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-center space-y-2">
                  <p className="text-[10px] uppercase tracking-widest text-emerald-300">Compare this code</p>
                  <p className="text-4xl font-black tracking-[0.3em] tabular-nums">{verificationCode}</p>
                  <p className="text-xs text-gray-400">Only continue if the other device shows exactly the same code.</p>
                  {!sourceVerified && (
                    <button disabled={busy} onClick={verifySource} className="w-full rounded-xl bg-emerald-600 py-3 text-xs font-bold disabled:opacity-50">
                      Confirm matching code
                    </button>
                  )}
                  {sourceVerified && !bundleSent && (
                    <button disabled={busy} onClick={sendAccountKeys} className="w-full rounded-xl bg-indigo-600 py-3 text-xs font-bold disabled:opacity-50">
                      Transfer account signing keys
                    </button>
                  )}
                  {bundleSent && !receiptVerified && (
                    <button disabled={busy} onClick={checkAccountKeysReceipt} className="w-full rounded-xl border border-white/10 py-3 text-xs font-bold disabled:opacity-50">
                      Check new-device confirmation
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {cameraActive ? (
            <div className="overflow-hidden rounded-2xl bg-black">
              <video ref={videoRef} autoPlay muted playsInline className="w-full aspect-square object-cover" />
            </div>
          ) : (
            <button onClick={() => setCameraActive(true)} className="w-full rounded-xl border border-white/10 py-3 text-xs font-semibold flex items-center justify-center gap-2">
              <Camera size={15} /> Open camera scanner
            </button>
          )}
          <textarea
            value={qrInput}
            onChange={(event) => setQrInput(event.target.value)}
            placeholder="Or paste the Dcalls QR pairing text here"
            rows={3}
            className="w-full rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-white outline-none focus:border-indigo-500"
          />
          <button disabled={busy || !qrInput.trim()} onClick={joinQr} className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-bold disabled:opacity-50">
            Join pairing session
          </button>
          {sessionId && !scannerCompleted && (
            <button disabled={busy} onClick={completeJoin} className="w-full rounded-xl border border-white/10 py-3 text-xs font-bold disabled:opacity-50">
              Check for approval
            </button>
          )}
          {verificationCode && (
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-center space-y-2">
              <p className="text-[10px] uppercase tracking-widest text-emerald-300">Compare this code</p>
              <p className="text-4xl font-black tracking-[0.3em] tabular-nums">{verificationCode}</p>
              <p className="text-xs text-gray-400">Verify that the existing device displays the same code.</p>
              {scannerCompleted && !scannerCodeConfirmed && (
                <button onClick={() => {
                  setScannerCodeConfirmed(true);
                  setStatus('You confirmed that both devices display the same verification code.');
                }} className="w-full rounded-xl border border-emerald-500/30 py-3 text-xs font-bold text-emerald-300">
                  I confirm the codes match
                </button>
              )}
              {scannerCompleted && scannerCodeConfirmed && !bundleReceived && (
                <button disabled={busy} onClick={receiveAccountKeys} className="w-full rounded-xl bg-indigo-600 py-3 text-xs font-bold disabled:opacity-50">
                  Receive account signing keys
                </button>
              )}
              {bundleReceived && !linkComplete && (
                <button disabled={busy} onClick={confirmLinkCompletion} className="w-full rounded-xl bg-emerald-600 py-3 text-xs font-bold disabled:opacity-50">
                  Check linking status
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className={`rounded-xl border p-3 flex items-start gap-2 ${linkComplete ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-white/10 bg-white/[0.03]'}`}>
        {linkComplete || status.includes('verified') || status.includes('established') ? <CheckCircle2 size={16} className="text-emerald-400 mt-0.5" /> : <Smartphone size={16} className="text-gray-400 mt-0.5" />}
        <div className="flex-1">
          <p className="text-xs font-semibold" role="status" aria-live="polite">{status}</p>
          <p className="text-[10px] text-gray-500 mt-1">A device is marked as linked only after the encrypted account-key transfer is acknowledged by the new device and confirmed by the existing device. Message history is not transferred.</p>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 flex items-start gap-2 text-red-300">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <p className="text-xs break-words" role="alert">{error}</p>
        </div>
      )}

      <div className="space-y-3">
        <p className="text-[10px] leading-relaxed text-gray-500">
          Removing a device blocks future key distribution. It cannot erase messages or encryption keys already stored on that device.
        </p>
        <div className="flex items-center justify-between">
          <h4 className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Linked Devices</h4>
          <button disabled={busy} onClick={() => run(refreshRegisteredDevices)} className="text-[10px] text-indigo-300">Refresh</button>
        </div>
        {registeredDevices.length === 0 ? (
          <p className="text-xs text-gray-500">No devices are listed for this account yet.</p>
        ) : registeredDevices.map((device) => {
          const unsigned = device.deviceKeys?.unsigned as Record<string, unknown> | undefined;
          const label = typeof unsigned?.device_display_name === 'string'
            ? unsigned.device_display_name
            : device.id === deviceId ? 'This device' : 'Dcalls device';
          const revoked = Boolean(device.revokedAt);
          const current = device.id === deviceId;
          const linked = Boolean(device.linkedAt);
          const deviceStatus = revoked ? 'Access removed' : current ? 'This device' : linked ? 'Linked' : 'Status not confirmed';
          return (
            <div key={device.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3 flex items-center gap-3">
              <Smartphone size={17} className={revoked ? 'text-gray-600' : 'text-indigo-300'} />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold">{label}{current ? ' · Current' : ''}</p>
                <p className="text-[9px] text-gray-500 truncate">{device.id}</p>
                <p className={`text-[9px] ${revoked ? 'text-red-300' : linked || current ? 'text-emerald-300' : 'text-gray-500'}`}>{deviceStatus}</p>
              </div>
              {!current && !revoked && (
                pendingRevocationId === device.id ? (
                  <div className="flex flex-col items-end gap-2">
                    <span className="text-[9px] text-red-300">This cannot be undone. The device may keep data already stored on it.</span>
                    <div className="flex items-center gap-2">
                      <button disabled={busy} onClick={() => revokeDevice(device.id)} className="text-[10px] font-bold text-red-300 disabled:opacity-50">
                        Remove access
                      </button>
                      <button disabled={busy} onClick={() => setPendingRevocationId(null)} className="text-[10px] text-gray-400 disabled:opacity-50">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button disabled={busy} onClick={() => setPendingRevocationId(device.id)} className="text-[10px] font-semibold text-red-300 disabled:opacity-50">
                    Remove access
                  </button>
                )
              )}
            </div>
          );
        })}
      </div>

      {sessionId && (
        <button disabled={busy} onClick={cancel} className="w-full rounded-xl border border-red-500/20 py-3 text-xs font-semibold text-red-300 disabled:opacity-50 flex items-center justify-center gap-2">
          <XCircle size={14} /> Cancel pairing
        </button>
      )}
    </div>
  );
};

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Camera, CheckCircle2, Copy, Link2, Loader2, RefreshCw, ShieldCheck, Smartphone, XCircle } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { matrixCryptoService } from '../services/matrixCryptoService';
import { qrDeviceLinkService } from '../services/qrDeviceLinkService';

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
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let active = true;
    matrixCryptoService.getDeviceId(userId)
      .then((id) => { if (active) setDeviceId(id); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
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
        setError(reason instanceof Error ? reason.message : 'Unable to read the camera image.');
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
        setError(reason instanceof Error ? reason.message : 'Camera permission was denied.');
        setCameraActive(false);
      });

    return () => {
      active = false;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
    };
  }, [cameraActive]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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
    setStatus('QR ready. Scan it using your new Dcalls device.');
  });

  const acceptJoin = () => run(async () => {
    if (!sessionId) throw new Error('Create a QR session first.');
    const code = await qrDeviceLinkService.acceptJoin(userId, sessionId);
    setVerificationCode(code);
    setStatus('New device accepted. Compare the verification code on both devices.');
  });

  const verifySource = () => run(async () => {
    if (!sessionId) throw new Error('No active pairing session.');
    const code = await qrDeviceLinkService.verifySourceCompletion(userId, sessionId);
    setVerificationCode(code);
    setStatus('HPKE channel verified. Secret and history transfer is the next stage.');
  });

  const joinQr = () => run(async () => {
    if (!userId || !deviceId || !qrInput.trim()) throw new Error('Paste or scan the QR code first.');
    await matrixCryptoService.publishInitialDeviceKeys(userId);
    const joined = await qrDeviceLinkService.joinSession(userId, deviceId, qrInput.trim());
    setSessionId(joined);
    setVerificationCode('');
    setStatus('Pairing request sent. Approve it on the device displaying the QR code.');
  });

  const completeJoin = () => run(async () => {
    if (!sessionId) throw new Error('Scan a Dcalls pairing QR code first.');
    const code = await qrDeviceLinkService.completeJoin(userId, sessionId);
    setVerificationCode(code);
    setStatus('Secure channel established. Compare this code with the existing device.');
  });

  const cancel = () => run(async () => {
    if (sessionId) await qrDeviceLinkService.cancelSession(userId, sessionId);
    setSessionId('');
    setQrPayload('');
    setExpiresAt(null);
    setVerificationCode('');
    setStatus('Pairing cancelled.');
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
              <button disabled={busy} onClick={acceptJoin} className="w-full rounded-xl bg-indigo-600/20 border border-indigo-500/30 py-3 text-xs font-bold disabled:opacity-50">
                Approve new device
              </button>
              {verificationCode && (
                <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-center space-y-2">
                  <p className="text-[10px] uppercase tracking-widest text-emerald-300">Compare this code</p>
                  <p className="text-4xl font-black tracking-[0.3em] tabular-nums">{verificationCode}</p>
                  <p className="text-xs text-gray-400">Only continue if the other device shows exactly the same code.</p>
                  <button disabled={busy} onClick={verifySource} className="w-full rounded-xl bg-emerald-600 py-3 text-xs font-bold disabled:opacity-50">
                    Confirm matching code
                  </button>
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
          {sessionId && (
            <button disabled={busy} onClick={completeJoin} className="w-full rounded-xl border border-white/10 py-3 text-xs font-bold disabled:opacity-50">
              Check for approval
            </button>
          )}
          {verificationCode && (
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-center space-y-2">
              <p className="text-[10px] uppercase tracking-widest text-emerald-300">Compare this code</p>
              <p className="text-4xl font-black tracking-[0.3em] tabular-nums">{verificationCode}</p>
              <p className="text-xs text-gray-400">Verify that the existing device displays the same code.</p>
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 flex items-start gap-2">
        {status.includes('verified') || status.includes('established') ? <CheckCircle2 size={16} className="text-emerald-400 mt-0.5" /> : <Smartphone size={16} className="text-gray-400 mt-0.5" />}
        <div className="flex-1">
          <p className="text-xs font-semibold">{status}</p>
          <p className="text-[10px] text-gray-500 mt-1">This stage verifies the encrypted channel only. Account secrets, message history and device trust transfer are not enabled yet.</p>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 flex items-start gap-2 text-red-300">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <p className="text-xs break-words">{error}</p>
        </div>
      )}

      {sessionId && (
        <button disabled={busy} onClick={cancel} className="w-full rounded-xl border border-red-500/20 py-3 text-xs font-semibold text-red-300 disabled:opacity-50 flex items-center justify-center gap-2">
          <XCircle size={14} /> Cancel pairing
        </button>
      )}
    </div>
  );
};

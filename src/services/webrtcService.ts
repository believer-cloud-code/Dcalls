import {
  collection,
  doc,
  addDoc,
  onSnapshot,
  updateDoc,
  getDoc,
  setDoc,
  serverTimestamp,
  DocumentReference,
  Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';

const iceServers: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

// Optional TURN — set VITE_TURN_* in .env for NAT-restricted networks
const turnUrl = import.meta.env.VITE_TURN_URL;
const turnUsername = import.meta.env.VITE_TURN_USERNAME;
const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;
if (turnUrl && turnUsername && turnCredential) {
  const normalizedTurn = turnUrl.startsWith('turn:') || turnUrl.startsWith('turns:')
    ? turnUrl
    : `turn:${turnUrl}`;
  iceServers.push({
    urls: normalizedTurn,
    username: turnUsername,
    credential: turnCredential,
  });
}

const servers: RTCConfiguration = {
  iceServers,
  iceCandidatePoolSize: 10,
};

function stripCandidateForIce(data: Record<string, unknown>): RTCIceCandidateInit {
  return {
    candidate: data.candidate as string | undefined,
    sdpMid: (data.sdpMid as string | null) ?? undefined,
    sdpMLineIndex: data.sdpMLineIndex as number | null | undefined,
    usernameFragment: data.usernameFragment as string | undefined,
  };
}

export class WebRTCService {
  private static instance: WebRTCService;
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private callId: string | null = null;
  private unsubscribers: Array<() => void> = [];
  private onErrorCallback: ((error: string) => void) | null = null;
  private onConnectedCallback: (() => void) | null = null;
  private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
  private unansweredTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private isEnding = false;

  private constructor() {}

  static getInstance(): WebRTCService {
    if (!WebRTCService.instance) {
      WebRTCService.instance = new WebRTCService();
    }
    return WebRTCService.instance;
  }

  private attachConnectionHandlers() {
    if (!this.pc) return;

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      if (state === 'connected') {
        this.clearConnectionTimeout();
        this.onConnectedCallback?.();
      } else if (state === 'failed') {
        this.onErrorCallback?.('Unable to connect');
        void this.endCall();
      } else if (state === 'disconnected') {
        // Allow ICE to recover briefly before failing
        setTimeout(() => {
          if (this.pc?.connectionState === 'disconnected') {
            this.onErrorCallback?.('Unable to connect');
            void this.endCall();
          }
        }, 5000);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const iceState = this.pc?.iceConnectionState;
      if (iceState === 'connected' || iceState === 'completed') {
        this.clearConnectionTimeout();
        this.onConnectedCallback?.();
      } else if (iceState === 'failed') {
        this.onErrorCallback?.('Unable to connect');
        void this.endCall();
      }
    };
  }

  private initializePeerConnection() {
    this.closePeerConnection(false);
    this.pc = new RTCPeerConnection(servers);
    this.pendingCandidates = [];
    this.attachConnectionHandlers();
  }

  private async addIceCandidateSafe(init: RTCIceCandidateInit) {
    if (!this.pc || !init.candidate) return;

    if (!this.pc.remoteDescription) {
      this.pendingCandidates.push(init);
      return;
    }

    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(init));
    } catch (error) {
      console.warn('addIceCandidate failed:', error);
    }
  }

  private async flushPendingCandidates() {
    if (!this.pc?.remoteDescription) return;
    const queued = [...this.pendingCandidates];
    this.pendingCandidates = [];
    for (const init of queued) {
      await this.addIceCandidateSafe(init);
    }
  }

  private subscribeCandidates(
    candidatesCol: ReturnType<typeof collection>,
    localUserId: string
  ): Unsubscribe {
    return onSnapshot(candidatesCol, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type !== 'added') return;
        const data = change.doc.data();
        if (data.senderId === localUserId) return;
        void this.addIceCandidateSafe(stripCandidateForIce(data));
      });
    });
  }

  private waitForOfferSdp(
    offerDoc: DocumentReference,
    timeoutMs = 20000
  ): Promise<{ type: RTCSdpType; sdp: string }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsub();
        reject(new Error('offer_timeout'));
      }, timeoutMs);

      const unsub = onSnapshot(
        offerDoc,
        (snapshot) => {
          const data = snapshot.data();
          if (data?.sdp && data?.type) {
            clearTimeout(timeout);
            unsub();
            resolve({ type: data.type as RTCSdpType, sdp: data.sdp as string });
          }
        },
        (error) => {
          clearTimeout(timeout);
          unsub();
          reject(error);
        }
      );
    });
  }

  private clearConnectionTimeout() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }

  private startConnectionTimeout() {
    this.clearConnectionTimeout();
    this.connectionTimeout = setTimeout(() => {
      const connected =
        this.pc?.connectionState === 'connected' ||
        this.pc?.iceConnectionState === 'connected' ||
        this.pc?.iceConnectionState === 'completed';
      if (!connected) {
        this.onErrorCallback?.('Unable to connect');
        void this.endCall();
      }
    }, 45000);
  }

  private closePeerConnection(clearCallbacks = true) {
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
    if (this.unansweredTimeout) clearTimeout(this.unansweredTimeout);
    this.connectionTimeout = null;
    this.unansweredTimeout = null;

    this.unsubscribers.forEach((unsub) => unsub());
    this.unsubscribers = [];
    this.pendingCandidates = [];

    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.remoteStream = null;

    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }

    if (clearCallbacks) {
      this.onErrorCallback = null;
      this.onConnectedCallback = null;
    }
  }

  cleanup() {
    this.closePeerConnection(true);
    this.callId = null;
    this.isEnding = false;
  }

  setOnError(callback: (error: string) => void) {
    this.onErrorCallback = callback;
  }

  setOnConnected(callback: () => void) {
    this.onConnectedCallback = callback;
  }

  getConnectionState(): RTCPeerConnectionState | null {
    return this.pc?.connectionState ?? null;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  async startLocalStream(type: 'voice' | 'video') {
    this.initializePeerConnection();

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      if (type === 'voice') {
        this.localStream.getVideoTracks().forEach((track) => {
          track.enabled = false;
        });
      }
    } catch (err) {
      console.warn('Could not acquire video, falling back to audio only', err);
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: true,
      });
    }

    this.remoteStream = new MediaStream();

    this.localStream.getTracks().forEach((track) => {
      this.pc!.addTrack(track, this.localStream!);
    });

    this.pc!.ontrack = (event) => {
      const stream = event.streams?.[0];
      if (!stream) return;
      stream.getTracks().forEach((track) => {
        const exists = this.remoteStream
          ?.getTracks()
          .some((t) => t.id === track.id);
        if (!exists) {
          this.remoteStream?.addTrack(track);
        }
      });
    };

    return { localStream: this.localStream, remoteStream: this.remoteStream };
  }

  async createCall(callerId: string, receiverId: string, type: 'voice' | 'video') {
    if (!this.pc) {
      throw new Error('Peer connection not initialized. Call startLocalStream first.');
    }

    const callDoc = doc(collection(db, 'calls'));
    const offerDoc = doc(callDoc, 'offer', 'sdp');
    const answerDoc = doc(callDoc, 'answer', 'sdp');
    const candidatesCol = collection(callDoc, 'candidates');

    this.callId = callDoc.id;

    this.pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      void addDoc(candidatesCol, {
        ...event.candidate.toJSON(),
        senderId: callerId,
        createdAt: serverTimestamp(),
      }).catch((e) => console.error('Failed to send ICE candidate', e));
    };

    const offerDescription = await this.pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: type === 'video',
    });
    await this.pc.setLocalDescription(offerDescription);

    await setDoc(callDoc, {
      callerId,
      receiverId,
      type,
      status: 'ringing',
      createdAt: serverTimestamp(),
    });

    await setDoc(offerDoc, {
      sdp: offerDescription.sdp,
      type: offerDescription.type,
      createdAt: serverTimestamp(),
    });

    this.unansweredTimeout = setTimeout(async () => {
      const currentCall = await getDoc(callDoc);
      if (currentCall.exists() && currentCall.data().status === 'ringing') {
        this.onErrorCallback?.('Call not answered');
        await this.endCall();
      }
    }, 60000);

    let candidatesUnsub: Unsubscribe | null = null;

    const unsubAnswer = onSnapshot(answerDoc, async (snapshot) => {
      try {
        const data = snapshot.data();
        if (this.pc?.currentRemoteDescription || !data?.sdp) return;

        const answerDescription = new RTCSessionDescription({
          type: data.type as RTCSdpType,
          sdp: data.sdp,
        });
        await this.pc!.setRemoteDescription(answerDescription);
        await this.flushPendingCandidates();
        this.startConnectionTimeout();

        if (!candidatesUnsub) {
          candidatesUnsub = this.subscribeCandidates(candidatesCol, callerId);
          this.unsubscribers.push(candidatesUnsub);
        }

        if (this.unansweredTimeout) {
          clearTimeout(this.unansweredTimeout);
          this.unansweredTimeout = null;
        }
      } catch (error) {
        console.error('Failed to apply answer:', error);
        this.onErrorCallback?.('Unable to connect');
      }
    });

    this.unsubscribers.push(unsubAnswer);

    return { callId: this.callId, unsubscribers: [unsubAnswer] };
  }

  async joinCall(callId: string, userId: string) {
    if (!this.pc) {
      throw new Error('Peer connection not initialized. Call startLocalStream first.');
    }

    this.callId = callId;
    const callDoc = doc(db, 'calls', callId);
    const offerDoc = doc(callDoc, 'offer', 'sdp');
    const answerDoc = doc(callDoc, 'answer', 'sdp');
    const candidatesCol = collection(callDoc, 'candidates');

    this.pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      void addDoc(candidatesCol, {
        ...event.candidate.toJSON(),
        senderId: userId,
        createdAt: serverTimestamp(),
      }).catch((e) => console.error('Failed to send ICE candidate', e));
    };

    let offerData: { type: RTCSdpType; sdp: string };
    try {
      const existing = (await getDoc(offerDoc)).data();
      if (existing?.sdp && existing?.type) {
        offerData = { type: existing.type as RTCSdpType, sdp: existing.sdp as string };
      } else {
        offerData = await this.waitForOfferSdp(offerDoc);
      }
    } catch (error) {
      console.error('Offer not available:', error);
      this.onErrorCallback?.('Unable to connect');
      return { error: 'missing_offer' as const };
    }

    await this.pc.setRemoteDescription(
      new RTCSessionDescription(offerData)
    );
    await this.flushPendingCandidates();

    const answerDescription = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answerDescription);

    await setDoc(answerDoc, {
      type: answerDescription.type,
      sdp: answerDescription.sdp,
      createdAt: serverTimestamp(),
    });

    await updateDoc(callDoc, { status: 'active' });

    const unsubCandidates = this.subscribeCandidates(candidatesCol, userId);
    this.unsubscribers.push(unsubCandidates);

    this.startConnectionTimeout();

    return { unsubscribers: [unsubCandidates] };
  }

  async endCall() {
    if (this.isEnding) return;
    this.isEnding = true;

    const id = this.callId;
    this.cleanup();

    if (id) {
      try {
        await updateDoc(doc(db, 'calls', id), {
          status: 'ended',
          endedAt: serverTimestamp(),
        });
      } catch (error) {
        console.error('Error updating call status:', error);
      }
    }
  }

  toggleAudio(isEnabled: boolean) {
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = isEnabled;
    });
  }

  toggleVideo(isEnabled: boolean) {
    this.localStream?.getVideoTracks().forEach((track) => {
      track.enabled = isEnabled;
    });
  }

  async setAudioOutput(
    deviceId: string,
    audioElements: (HTMLAudioElement | HTMLVideoElement)[]
  ) {
    for (const element of audioElements) {
      if ('setSinkId' in element) {
        try {
          await (element as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> })
            .setSinkId(deviceId);
        } catch (error) {
          console.error('Error setting sink ID:', error);
        }
      }
    }
  }

  async toggleScreenShare(isSharing: boolean): Promise<MediaStream | null> {
    if (!this.pc) return null;

    if (isSharing) {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      const videoTrack = screenStream.getVideoTracks()[0];
      const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video');

      if (sender && videoTrack) {
        await sender.replaceTrack(videoTrack);
        videoTrack.onended = () => {
          void this.toggleScreenShare(false);
        };
      }

      return screenStream;
    }

    const videoTrack = this.localStream?.getVideoTracks()[0];
    const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (sender && videoTrack) {
      await sender.replaceTrack(videoTrack);
    }
    return null;
  }

  onCallEnded(callback: () => void): (() => void) | undefined {
    if (!this.callId) return undefined;
    const callDoc = doc(db, 'calls', this.callId);
    const unsub = onSnapshot(callDoc, (snapshot) => {
      if (snapshot.data()?.status === 'ended') {
        callback();
      }
    });
    this.unsubscribers.push(unsub);
    return unsub;
  }
}

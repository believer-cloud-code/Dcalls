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
  query,
  orderBy,
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

  private constructor() { }

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
      console.log(`[WebRTC] Connection state changed: ${state}`);
      if (state === 'connected') {
        console.log(`[WebRTC] Call ${this.callId}: Connected!`);
        this.clearConnectionTimeout();
        this.onConnectedCallback?.();
      } else if (state === 'failed') {
        console.log(`[WebRTC] Call ${this.callId}: Connection failed`);
        this.onErrorCallback?.('Unable to connect');
        void this.endCall();
      } else if (state === 'disconnected') {
        console.log(`[WebRTC] Call ${this.callId}: Disconnected, waiting for recovery...`);
        // Allow ICE to recover briefly before failing
        setTimeout(() => {
          if (this.pc?.connectionState === 'disconnected') {
            console.log(`[WebRTC] Call ${this.callId}: Still disconnected after 5s, ending call`);
            this.onErrorCallback?.('Unable to connect');
            void this.endCall();
          }
        }, 5000);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const iceState = this.pc?.iceConnectionState;
      console.log(`[WebRTC] ICE connection state changed: ${iceState}`);
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
    this.internalCleanup(false);
    this.pc = new RTCPeerConnection(servers);
    this.pendingCandidates = [];
    this.attachConnectionHandlers();
  }

  private async addIceCandidateSafe(init: RTCIceCandidateInit) {
    if (!this.pc || !init.candidate) return;

    if (!this.pc.remoteDescription) {
      console.log(`[WebRTC] Pending ICE candidate (no remote description yet): ${init.candidate}`);
      this.pendingCandidates.push(init);
      return;
    }

    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(init));
      console.log(`[WebRTC] Added ICE candidate: ${init.candidate}`);
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
    // Subscribe to candidates ordered by creation time to avoid processing unordered batches
    const q = query(candidatesCol, orderBy('createdAt', 'asc'));
    return onSnapshot(
      q,
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type !== 'added') return;
          const data = change.doc.data();
          if (data.senderId === localUserId) return;
          console.log(`[WebRTC] Received ICE candidate from remote peer`);
          void this.addIceCandidateSafe(stripCandidateForIce(data));
        });
      },
      (error) => {
        console.error('[WebRTC] Error listening to ICE candidates:', error);
      }
    );
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
    }, 75000); // 75 seconds

    // Monitor connection state changes to clear timeout when successful
    if (this.pc) {
      const checkConnection = () => {
        const connected =
          this.pc?.connectionState === 'connected' ||
          this.pc?.iceConnectionState === 'connected' ||
          this.pc?.iceConnectionState === 'completed';
        if (connected) {
          this.clearConnectionTimeout();
          this.onConnectedCallback?.();
          this.pc?.removeEventListener('connectionstatechange', checkConnection);
          this.pc?.removeEventListener('iceconnectionstatechange', checkConnection);
        }
      };
      this.pc.addEventListener('connectionstatechange', checkConnection);
      this.pc.addEventListener('iceconnectionstatechange', checkConnection);
    }
  }


  private internalCleanup(clearCallbacks = true) {
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

    this.callId = null;
  }

  cleanup() {
    this.internalCleanup(true);
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
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: true,
        });
      } catch (fallbackErr) {
        console.error('Failed to acquire audio stream:', fallbackErr);
        throw new Error('Unable to access microphone');
      }
    }

    this.remoteStream = new MediaStream();

    this.localStream.getTracks().forEach((track) => {
      this.pc!.addTrack(track, this.localStream!);
    });

    this.pc!.ontrack = (event) => {
      const stream = event.streams?.[0];
      if (!stream) return;
      console.log(`[WebRTC] Remote track received: ${event.track.kind}`);
      stream.getTracks().forEach((track) => {
        const exists = this.remoteStream
          ?.getTracks()
          .some((t) => t.id === track.id);
        if (!exists) {
          this.remoteStream?.addTrack(track);
          console.log(`[WebRTC] Added ${track.kind} track to remote stream`);
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
    console.log(`[WebRTC] Creating call ${this.callId} from ${callerId} to ${receiverId} (${type})`);

    this.pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      console.log(`[WebRTC] Caller ICE candidate: ${event.candidate.candidate}`);
      addDoc(candidatesCol, {
        ...event.candidate.toJSON(),
        senderId: callerId,
        createdAt: serverTimestamp(),
      }).catch((e) => console.error('[WebRTC] Failed to send ICE candidate:', e));
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
    console.log(`[WebRTC] Call ${this.callId}: Offer written to Firestore`);

    // Subscribe to ICE candidates immediately (before answer arrives)
    const candidatesUnsub = this.subscribeCandidates(candidatesCol, callerId);
    this.unsubscribers.push(candidatesUnsub);
    console.log(`[WebRTC] Call ${this.callId}: Subscribed to ICE candidates`);

    this.unansweredTimeout = setTimeout(() => {
      (async () => {
        try {
          const currentCall = await getDoc(callDoc);
          if (currentCall.exists() && currentCall.data()?.status === 'ringing') {
            console.log(`[WebRTC] Call ${this.callId}: No answer received after 100 seconds`);
            this.onErrorCallback?.('Call not answered');
            await this.endCall();
          }
        } catch (error) {
          console.error('Error checking unanswered call:', error);
        }
      })().catch((error) => {
        console.error('[WebRTC] Unhandled error in unanswered timeout:', error);
      });
    }, 100000); // 100 seconds

    const unsubAnswer = onSnapshot(
      answerDoc,
      (snapshot) => {
        (async () => {
          try {
            const data = snapshot.data();
            if (this.pc?.currentRemoteDescription || !data?.sdp) return;

            console.log(`[WebRTC] Call ${this.callId}: Answer received`);
            const answerDescription = new RTCSessionDescription({
              type: data.type as RTCSdpType,
              sdp: data.sdp,
            });
            await this.pc!.setRemoteDescription(answerDescription);
            console.log(`[WebRTC] Call ${this.callId}: Remote description set (answer)`);
            await this.flushPendingCandidates();
            this.startConnectionTimeout();

            if (this.unansweredTimeout) {
              clearTimeout(this.unansweredTimeout);
              this.unansweredTimeout = null;
            }
          } catch (error) {
            console.error('Failed to apply answer:', error);
            this.onErrorCallback?.('Unable to connect');
          }
        })().catch((error) => {
          console.error('[WebRTC] Unhandled error in answer snapshot listener:', error);
        });
      },
      (error) => {
        console.error('[WebRTC] Error listening to answer:', error);
        this.onErrorCallback?.('Unable to connect');
      }
    );

    this.unsubscribers.push(unsubAnswer);

    return { callId: this.callId, unsubscribers: [unsubAnswer, candidatesUnsub] };
  }

  async joinCall(callId: string, userId: string) {
    if (!this.pc) {
      throw new Error('Peer connection not initialized. Call startLocalStream first.');
    }

    this.callId = callId;
    console.log(`[WebRTC] Joining call ${callId} as user ${userId}`);
    const callDoc = doc(db, 'calls', callId);
    const offerDoc = doc(callDoc, 'offer', 'sdp');
    const answerDoc = doc(callDoc, 'answer', 'sdp');
    const candidatesCol = collection(callDoc, 'candidates');

    this.pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      console.log(`[WebRTC] Receiver ICE candidate: ${event.candidate.candidate}`);
      addDoc(candidatesCol, {
        ...event.candidate.toJSON(),
        senderId: userId,
        createdAt: serverTimestamp(),
      }).catch((e) => console.error('[WebRTC] Failed to send ICE candidate:', e));
    };

    let offerData: { type: RTCSdpType; sdp: string };
    try {
      const existing = (await getDoc(offerDoc)).data();
      if (existing?.sdp && existing?.type) {
        console.log(`[WebRTC] Call ${callId}: Offer already exists`);
        offerData = { type: existing.type as RTCSdpType, sdp: existing.sdp as string };
      } else {
        console.log(`[WebRTC] Call ${callId}: Waiting for offer...`);
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
    console.log(`[WebRTC] Call ${callId}: Remote description set (offer)`);
    await this.flushPendingCandidates();

    const answerDescription = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answerDescription);

    await setDoc(answerDoc, {
      type: answerDescription.type,
      sdp: answerDescription.sdp,
      createdAt: serverTimestamp(),
    });
    console.log(`[WebRTC] Call ${callId}: Answer written to Firestore`);

    await updateDoc(callDoc, { status: 'active' });

    const unsubCandidates = this.subscribeCandidates(candidatesCol, userId);
    this.unsubscribers.push(unsubCandidates);

    this.startConnectionTimeout();

    return { unsubscribers: [unsubCandidates] };
  }

  async endCall() {
    if (this.isEnding) {
      console.log('[WebRTC] endCall already in progress, ignoring duplicate call');
      return;
    }

    this.isEnding = true;

    const id = this.callId;

    // Clean up local resources immediately
    this.internalCleanup(true);

    // Update Firestore status, but keep isEnding = true until complete
    if (id) {
      try {
        await updateDoc(doc(db, 'calls', id), {
          status: 'ended',
          endedAt: serverTimestamp(),
        });
        console.log(`[WebRTC] Call ${id} marked as ended in Firestore`);
      } catch (error) {
        console.error('Error updating call status in Firestore:', error);
      } finally {
        // Only reset isEnding after the async operation is complete
        this.isEnding = false;
      }
    } else {
      // No call ID, still reset the flag
      this.isEnding = false;
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
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });

        const videoTrack = screenStream.getVideoTracks()[0];
        const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video');

        if (sender && videoTrack) {
          try {
            await sender.replaceTrack(videoTrack);
            videoTrack.onended = () => {
              void this.toggleScreenShare(false).catch((e) =>
                console.error('Error stopping screen share:', e)
              );
            };
          } catch (error) {
            console.error('Error replacing video track:', error);
            screenStream.getTracks().forEach((track) => track.stop());
            throw error;
          }
        }

        return screenStream;
      } catch (error) {
        console.error('Error starting screen share:', error);
        return null;
      }
    }

    try {
      const videoTrack = this.localStream?.getVideoTracks()[0];
      const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
      if (sender && videoTrack) {
        await sender.replaceTrack(videoTrack);
      }
    } catch (error) {
      console.error('Error stopping screen share:', error);
    }
    return null;
  }

  onCallEnded(callback: () => void): (() => void) | undefined {
    if (!this.callId) return undefined;
    const callDoc = doc(db, 'calls', this.callId);
    const unsub = onSnapshot(
      callDoc,
      (snapshot) => {
        if (snapshot.data()?.status === 'ended') {
          callback();
        }
      },
      (error) => {
        console.error('[WebRTC] Error monitoring call end status:', error);
      }
    );
    this.unsubscribers.push(unsub);
    return unsub;
  }
}

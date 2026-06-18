# SAFE_PATCH_PLAN.md

**Source of truth:** Post-fix verification audit (2026-06-17)  
**Scope:** Verified regressions only — no architecture redesign, no unrelated refactors  
**Firebase plan:** All changes remain Spark-compatible (no Cloud Functions, no new paid services)

---

## Patch order

Apply patches in priority order. Each patch is independent within its priority tier but **P0 must land before P1** (P1 builds on the P0 merge logic in `ChatInterface.tsx`).

| Priority | ID | Summary |
|----------|-----|---------|
| P0 | P0-A | `ChatInterface` — replace `return prev` with field-aware merge |
| P0 | P0-B | `DamaiChat` — replace `return prev` with field-aware merge |
| P1 | P1-A | `types.ts` — add optional `clientId` |
| P1 | P1-B | `ChatInterface` — write `clientId` on send |
| P1 | P1-C | `ChatInterface` — `clientId`-based pending filter |
| P2 | P2-A | `DamaiChat` — remove duplicate global loading indicator |
| P2 | P2-B | `DamaiChat` — stop persisting loading flag as `isThinking` |
| P2 | P2-C | `DamaiChat` — simplify snapshot placeholder merge (ID-only, no text match) |
| P3 | P3-A | `ChatInterface` — remove dead `isTranslating` state |

---

## P0 — Read receipts and stale UI (`return prev`)

### P0-A — `ChatInterface.tsx` onSnapshot merge

**Verified issue:** `return prev` when `length` and `lastId` are unchanged blocks `status: 'read'`, `feedback`, and other in-place Firestore field updates from reaching the UI.

**File:** `src/components/ChatInterface.tsx`

#### Remove

```typescript
  const prevMessagesRef = useRef<Message[] | null>(null);
  const readMarkedRef = useRef<Set<string>>(new Set());
```

(Remove only `prevMessagesRef` line; keep `readMarkedRef`.)

```typescript
      setMessages(prev => {
        const prevTemps = (prev || []).filter(m => typeof m.id === 'string' && m.id.startsWith('temp-') && m.status !== 'sent');
        const pending = prevTemps.filter(temp => !serverMsgs.some(s => s.text === temp.text && s.senderId === temp.senderId));

        const prevLastId = prev && prev.length > 0 ? prev[prev.length - 1].id : null;
        const newLastId = serverMsgs.length > 0 ? serverMsgs[serverMsgs.length - 1].id : null;

        if (prev && prev.length === serverMsgs.length + pending.length && prevLastId === newLastId) {
          return prev; // no change
        }

        const merged = [...serverMsgs, ...pending];
        prevMessagesRef.current = merged;
        return merged;
      });
```

#### Replace with

```typescript
      setMessages(prev => {
        const prevTemps = (prev || []).filter(
          m => typeof m.id === 'string' && m.id.startsWith('temp-') && m.status !== 'sent'
        );
        // P1-C will replace this filter with clientId-based matching
        const pending = prevTemps.filter(
          temp => !serverMsgs.some(s => s.text === temp.text && s.senderId === temp.senderId)
        );

        const merged = [...serverMsgs, ...pending];

        if (prev && prev.length === merged.length) {
          const unchanged = merged.every((m, i) => {
            const p = prev[i];
            if (!p || p.id !== m.id) return false;
            return (
              p.status === m.status &&
              p.feedback === m.feedback &&
              p.text === m.text &&
              p.senderId === m.senderId &&
              p.type === m.type
            );
          });
          if (unchanged) return prev;
        }

        return merged;
      });
```

**Explanation:** Keeps the existing optimistic-merge behavior (unchanged until P1-C) but only skips `setState` when **per-message fields that affect the UI** are identical. Read-status and feedback updates from Firestore now propagate even when no new messages are appended.

**Risk level:** Low–Medium (more frequent React re-renders on metadata-only snapshot events; functionally correct)

**Testing procedure:**
1. Open a 1:1 chat on device A (sender) and device B (recipient).
2. Sender sends a message; confirm single bubble, no duplicate.
3. Recipient opens chat; confirm messages marked read in Firestore (`status: 'read'`).
4. On sender, confirm checkmarks update to double-check (read) **without sending a new message**.
5. Tap thumbs-up on an AI message; confirm highlight appears without a new message.
6. Send while offline / slow network; confirm optimistic bubble still appears (P1 will harden this).

**Impact estimate:**

| Dimension | Impact |
|-----------|--------|
| Firebase reads | **No change** — snapshots still fire at the same rate |
| Firebase writes | **No change** |
| UI | **Fixes** read receipts and feedback display; slightly more re-renders on metadata updates |
| Regression risk | Low — worst case is extra renders; no new writes or listeners |

---

### P0-B — `DamaiChat.tsx` onSnapshot merge

**Verified issue:** Same `return prev` pattern blocks `sources` and other field updates on existing messages.

**File:** `src/components/DamaiChat.tsx`

#### Remove

```typescript
      // Avoid unnecessary state updates: merge with local optimistic placeholders
      setMessages(prev => {
        const prevTemps = (prev || []).filter(m => typeof m.id === 'string' && (m.id as string).startsWith('local-ai-') && m.isThinking);
        const pending = prevTemps.filter(temp => !serverMsgs.some(s => s.text === temp.text && s.sender === temp.sender));

        const prevLastId = prev && prev.length > 0 ? prev[prev.length - 1].id : null;
        const newLastId = serverMsgs.length > 0 ? serverMsgs[serverMsgs.length - 1].id : null;
        if (prev && prev.length === serverMsgs.length + pending.length && prevLastId === newLastId) return prev;
        return [...serverMsgs, ...pending];
      });
```

#### Replace with

```typescript
      setMessages(prev => {
        const placeholders = (prev || []).filter(
          m => typeof m.id === 'string' && m.id.startsWith('local-ai-') && m.isThinking
        );
        const merged = [...serverMsgs, ...placeholders];

        if (prev && prev.length === merged.length) {
          const unchanged = merged.every((m, i) => {
            const p = prev[i];
            if (!p || p.id !== m.id) return false;
            return (
              p.text === m.text &&
              p.sender === m.sender &&
              p.isThinking === m.isThinking &&
              JSON.stringify(p.sources ?? []) === JSON.stringify(m.sources ?? [])
            );
          });
          if (unchanged) return prev;
        }

        return merged;
      });
```

**Explanation:** Drops `length + lastId` short-circuit. Preserves `local-ai-*` placeholders by **local ID only** (no text matching). Field-aware equality allows server-side updates to existing messages to render.

**Risk level:** Low

**Testing procedure:**
1. Open Damai chat; send a message; confirm AI response appears once after completion.
2. During generation, confirm `local-ai-*` placeholder remains visible.
3. Open a thread with messages that have `sources`; confirm sources render.
4. Switch threads and back; confirm message list is correct.

**Impact estimate:**

| Dimension | Impact |
|-----------|--------|
| Firebase reads | **No change** |
| Firebase writes | **No change** |
| UI | **Fixes** stale message fields; placeholders preserved by ID |
| Regression risk | Low |

---

## P1 — `clientId`-based optimistic reconciliation (`ChatInterface`)

### P1-A — Add `clientId` to `Message` type

**Verified issue:** Text+sender reconciliation fails for encrypted sends and identical consecutive messages.

**File:** `src/types.ts`

#### Remove

```typescript
export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  text: string;
```

#### Replace with

```typescript
export interface Message {
  id: string;
  /** Client-generated ID written to Firestore for optimistic reconciliation */
  clientId?: string;
  chatId: string;
  senderId: string;
  text: string;
```

**Explanation:** Optional field — backward-compatible with existing Firestore documents that lack `clientId`.

**Risk level:** Low

**Testing procedure:** TypeScript build passes; no runtime change until P1-B/C.

**Impact estimate:**

| Dimension | Impact |
|-----------|--------|
| Firebase reads | None |
| Firebase writes | None (until P1-B) |
| UI | None |
| Regression risk | None |

---

### P1-B — Persist `clientId` on send

**File:** `src/components/ChatInterface.tsx`

#### Remove

```typescript
        const messageRef = await addDoc(messagesRef, {
          chatId,
          senderId: auth.currentUser.uid,
          text: encryptedText,
          isEncrypted,
          ...(encryptionMethod ? { encryptionMethod } : {}),
          timestamp: serverTimestamp(),
          type: 'text',
          status: 'sent'
        });
```

#### Replace with

```typescript
        const messageRef = await addDoc(messagesRef, {
          chatId,
          clientId: tempId,
          senderId: auth.currentUser.uid,
          text: encryptedText,
          isEncrypted,
          ...(encryptionMethod ? { encryptionMethod } : {}),
          timestamp: serverTimestamp(),
          type: 'text',
          status: 'sent'
        });
```

**Explanation:** Links the Firestore document to the optimistic `temp-*` ID. Reconciliation no longer depends on plaintext matching ciphertext.

**Risk level:** Low

**Testing procedure:**
1. Inspect Firestore after send — document contains `clientId` matching `temp-*` prefix pattern.
2. Encrypted chat: send message; confirm **one** bubble (no plaintext + ciphertext duplicate).
3. Send `"Hi"` twice quickly; confirm **two** bubbles remain until both server docs arrive.

**Impact estimate:**

| Dimension | Impact |
|-----------|--------|
| Firebase reads | None |
| Firebase writes | **+0 per message** — one extra string field in existing `addDoc` (negligible bytes) |
| UI | **Fixes** encrypted duplicate and identical-text optimistic loss |
| Regression risk | Low — old messages without `clientId` still work via P1-C fallback |

---

### P1-C — `clientId`-based pending filter

**File:** `src/components/ChatInterface.tsx` (inside `onSnapshot` `setMessages` callback from P0-A)

#### Remove

```typescript
        const pending = prevTemps.filter(
          temp => !serverMsgs.some(s => s.text === temp.text && s.senderId === temp.senderId)
        );
```

#### Replace with

```typescript
        const pending = prevTemps.filter(
          temp => !serverMsgs.some(
            s => s.clientId === temp.id || (s.id === temp.id)
          )
        );
```

**Explanation:**
- Primary match: `server.clientId === temp.id` (correct for all encryption and duplicate-text cases).
- Fallback: `s.id === temp.id` covers messages already reconciled in `handleSend` before snapshot arrives.
- Text+sender matching is fully removed.

**Risk level:** Low

**Testing procedure:**
1. **Encrypted send:** Partner has `publicKey`; send short message; no duplicate bubbles at any point.
2. **Identical consecutive:** Send `"Hi"` → `"Hi"` rapidly; both optimistics visible until each server doc lands; final count = 2.
3. **Legacy messages:** Open chat with pre-patch messages (no `clientId`); list loads normally.
4. **Failed send:** Force network error; optimistic shows `failed`; no ghost duplicates on reconnect.

**Impact estimate:**

| Dimension | Impact |
|-----------|--------|
| Firebase reads | None |
| Firebase writes | None |
| UI | **Fixes** verified duplication and optimistic-loss bugs |
| Regression risk | Low — `clientId` fallback only applies to new sends |

---

## P2 — Damai loading indicators

### P2-A — Remove duplicate global loading indicator

**Verified issue:** During AI generation, user sees both `local-ai-*` placeholder bubble **and** global `isLoading` bounce dots (lines 840–851).

**File:** `src/components/DamaiChat.tsx`

#### Remove

```typescript
          {isLoading && (
            <div className="flex gap-4 max-w-3xl mx-auto w-full">
              <div className="w-8 h-8 rounded-lg bg-purple-600 flex items-center justify-center animate-pulse">
                <Bot size={16} className="text-white" />
              </div>
              <div className="flex gap-1 items-center h-8">
                <div className="w-1 h-1 bg-purple-500 rounded-full animate-bounce" />
                <div className="w-1 h-1 bg-purple-500 rounded-full animate-bounce [animation-delay:0.2s]" />
                <div className="w-1 h-1 bg-purple-500 rounded-full animate-bounce [animation-delay:0.4s]" />
              </div>
            </div>
          )}
```

#### Replace with

```typescript
          {/* AI loading shown only via local-ai-* placeholder in messages list */}
```

**Explanation:** `isLoading` remains for send-button `disabled` and suggestion gating (`!isLoading`). Only the redundant visual indicator is removed. One active AI loading surface: the `local-ai-*` message bubble.

**Risk level:** Low

**Testing procedure:**
1. Send message to Damai; during wait, confirm **one** loading indicator (placeholder bubble with `"Thinking..."`).
2. Confirm send button is disabled while `isLoading`.
3. Confirm suggestions hidden while `isLoading` (existing behavior).
4. Confirm no loading indicator after response completes.

**Impact estimate:**

| Dimension | Impact |
|-----------|--------|
| Firebase reads | None |
| Firebase writes | None |
| UI | **Removes** duplicate loading row; cleaner UX |
| Regression risk | Very low — purely subtractive UI |

---

### P2-B — Rename persisted thinking flag (`isThinking` → `thinkingMode`)

**Verified issue:** `isThinking: isThinkingMode` is saved to Firestore on AI replies. Render treats `msg.isThinking` as a loading/badge flag, so old thinking-mode replies permanently show "Deep Thinking Mode".

**File:** `src/components/DamaiChat.tsx`

#### Change 1 — local `Message` interface

**Remove:**

```typescript
  isThinking?: boolean;
```

**Replace with:**

```typescript
  isThinking?: boolean;   // local placeholder only (local-ai-*)
  thinkingMode?: boolean; // persisted: reply was generated in thinking mode
```

#### Change 2 — Firestore write

**Remove:**

```typescript
          isThinking: isThinkingMode
```

**Replace with:**

```typescript
          thinkingMode: isThinkingMode
```

#### Change 3 — render badge

**Remove:**

```typescript
                  {msg.isThinking && (
                    <div className="flex items-center gap-2 mb-2 text-[10px] font-bold text-purple-400 uppercase tracking-widest">
                      <Brain size={12} />
                      Deep Thinking Mode
                    </div>
                  )}
```

**Replace with:**

```typescript
                  {msg.thinkingMode && (
                    <div className="flex items-center gap-2 mb-2 text-[10px] font-bold text-purple-400 uppercase tracking-widest">
                      <Brain size={12} />
                      Deep Thinking Mode
                    </div>
                  )}
```

**Explanation:** Separates ephemeral loading state (`isThinking` on `local-ai-*` only) from persisted metadata (`thinkingMode` on server messages). Old documents with `isThinking: true` will stop showing the badge (acceptable — they were incorrectly labeled as loading).

**Risk level:** Low

**Testing procedure:**
1. Enable thinking mode; send message; after response, badge shows on **that** AI reply only while idle (not pulsing).
2. Send with thinking mode off; no badge on reply.
3. During generation, placeholder still shows `isThinking` local state (unaffected).
4. Old chats with `isThinking` in Firestore: badge no longer appears (expected migration gap).

**Impact estimate:**

| Dimension | Impact |
|-----------|--------|
| Firebase reads | None |
| Firebase writes | **No extra writes** — field rename only |
| UI | **Fixes** misleading badge on historical messages |
| Regression risk | Low — old `isThinking` field ignored in render |

---

### P2-C — Damai snapshot: ID-only placeholders (no text reconciliation)

**Verified issue:** Text-based `pending` filter in Damai is pointless (`"Thinking..."` never matches AI text) and was removed in P0-B. This patch documents the **intentional** final state after P0-B.

**File:** `src/components/DamaiChat.tsx`

**Action:** No additional code change if P0-B is applied as written. P0-B already uses ID-only `placeholders` filter.

**Explanation:** Placeholder lifecycle is owned by `handleSend` (`setMessages` add → `finally` filter remove). Snapshot only appends unresolved `local-ai-*` + `isThinking` placeholders.

**Risk level:** N/A (confirmation only)

**Testing procedure:** Same as P0-B + P2-A combined.

---

## P3 — Dead state removal

### P3-A — Remove unused `isTranslating`

**Verified issue:** `isTranslating` is declared and set during `@Damai` commands but **never read in JSX** (grep confirms only lines 56, 483, 568).

**File:** `src/components/ChatInterface.tsx`

#### Remove

```typescript
  const [isTranslating, setIsTranslating] = useState(false);
```

```typescript
        setIsTranslating(true); // Reusing translating state for AI loading
```

```typescript
          setIsTranslating(false);
```

(from the `finally` block of the `@Damai` branch)

#### Replace with

No replacement — delete only.

**Explanation:** Dead state adds confusion and suggests a loading UI that does not exist. Removing it has zero user-visible effect today.

**Risk level:** Very low

**Testing procedure:**
1. Send `@Damai summarize` in chat; confirm AI response still works.
2. Confirm no TypeScript errors for removed symbol.
3. Confirm no visual change (state was already invisible).

**Impact estimate:**

| Dimension | Impact |
|-----------|--------|
| Firebase reads | None |
| Firebase writes | None |
| UI | None (state was unused) |
| Regression risk | None |

---

## Out of scope (verified but not patched here)

These were identified in the audit but **exceed minimal-fix scope** per plan rules:

| Item | Reason excluded |
|------|-----------------|
| `prevMessagesRef` removal | Addressed in P0-A (remove unused ref) |
| Unbounded message listeners / `limit()` | Architecture/optimization — not required to fix verified bugs |
| ICE candidate cleanup / dedup | WebRTC — not messaging regression from recent patch |
| `DamaiChat` threads listener `[activeChatId]` dependency | Listener recreation — optimization, not verified user bug |
| Wire `isTranslating` to UI instead of remove | Would be new feature, not fix |

---

## Full regression checklist (post-patch)

Run after all patches applied:

- [ ] **P0** Sender sees read receipts update without new messages
- [ ] **P0** Feedback thumbs highlight after Firestore write
- [ ] **P1** Encrypted message: no duplicate bubbles
- [ ] **P1** Two identical texts: both delivered, no optimistic vanish
- [ ] **P2** Damai: exactly one loading indicator during AI wait
- [ ] **P2** Damai: thinking-mode badge only on `thinkingMode` replies, not all history
- [ ] **P3** `@Damai` commands still work
- [ ] No new Firestore listeners added
- [ ] No new Cloud Functions or Blaze-only APIs introduced

---

## Aggregate impact summary

| Patch | Reads | Writes | UI | Regression risk |
|-------|-------|--------|-----|-----------------|
| P0-A | — | — | Fixes read receipts, feedback | Low–Med |
| P0-B | — | — | Fixes stale Damai fields | Low |
| P1-A | — | — | — | None |
| P1-B | — | +0 (field in existing doc) | Fixes encrypted/duplicate | Low |
| P1-C | — | — | Fixes reconciliation | Low |
| P2-A | — | — | Removes duplicate loader | Very low |
| P2-B | — | — | Fixes badge on old msgs | Low |
| P2-C | — | — | (covered by P0-B) | — |
| P3-A | — | — | — | None |

**Net Firebase impact:** Zero additional reads or listener count. Zero additional writes per operation (one optional string field per new chat message). Fully Spark-compatible.

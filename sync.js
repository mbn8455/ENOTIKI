import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import { getDatabase, ref, onValue, set, get } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-database.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBahrECxSQqXi5hR-E7G1V9N_7s0dgHnPI",
  authDomain: "enotiki-bc52e.firebaseapp.com",
  databaseURL: "https://enotiki-bc52e-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "enotiki-bc52e"
};

const SYNC_STORAGE_KEY = "enotiki-sync-pass-v1";
const STATE_PATH = "state";
const PBKDF2_ITERATIONS = 150000;

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function newWriterId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
}

async function deriveKey(password, saltBytes) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptPayload(key, saltBytes, stateObj, updatedAt, writerId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(stateObj));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    ciphertext: bytesToBase64(new Uint8Array(cipherBuf)),
    iv: bytesToBase64(iv),
    salt: bytesToBase64(saltBytes),
    updatedAt,
    writerId
  };
}

async function decryptPayload(key, remote) {
  const iv = base64ToBytes(remote.iv);
  const cipherBytes = base64ToBytes(remote.ciphertext);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

const SyncManager = {
  _app: null,
  _auth: null,
  _db: null,
  _authReady: null,
  _key: null,
  _salt: null,
  // Random per-session id: identifies writes made by *this* tab so its own
  // echoed write can be ignored without relying on (skewable) clocks.
  _writerId: null,
  _lastAppliedAt: 0,
  _pushTimer: null,
  _subscribed: false,
  // Set when this session can no longer read the remote node (password changed
  // elsewhere): pushing would clobber data we cannot decrypt, so we stop.
  _stopped: false,
  _onRemoteState: null,
  _onError: null,
  _onPushStatus: null,

  init(onRemoteState, onError, onPushStatus) {
    this._onRemoteState = onRemoteState;
    this._onError = onError;
    this._onPushStatus = onPushStatus || null;
    if (!this._writerId) this._writerId = newWriterId();
    if (this._app) return this._authReady;
    this._app = initializeApp(FIREBASE_CONFIG);
    this._auth = getAuth(this._app);
    this._db = getDatabase(this._app);
    this._authReady = signInAnonymously(this._auth).catch((e) => {
      if (this._onError) this._onError("auth: " + e.message);
    });
    return this._authReady;
  },

  hasStoredPassword() {
    return !!localStorage.getItem(SYNC_STORAGE_KEY);
  },

  autoUnlock(currentLocalState) {
    const stored = localStorage.getItem(SYNC_STORAGE_KEY);
    if (!stored) return Promise.resolve({ ok: false, noPassword: true });
    return this.unlockWithPassword(stored, currentLocalState);
  },

  async unlockWithPassword(password, currentLocalState) {
    if (this._authReady) await this._authReady;
    const snap = await get(ref(this._db, STATE_PATH));
    const remote = snap.val();
    if (!remote) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(password, salt);
      this._salt = salt;
      this._key = key;
      this._stopped = false;
      this._lastAppliedAt = 0;
      localStorage.setItem(SYNC_STORAGE_KEY, password);
      const wroteAt = await this._writeRemote(currentLocalState);
      this._lastAppliedAt = wroteAt || 0;
      this._subscribe();
      return { ok: true, firstSetup: true, updatedAt: wroteAt || 0 };
    }
    const salt = base64ToBytes(remote.salt);
    const key = await deriveKey(password, salt);
    try {
      const state = await decryptPayload(key, remote);
      this._salt = salt;
      this._key = key;
      this._stopped = false;
      this._lastAppliedAt = remote.updatedAt || 0;
      localStorage.setItem(SYNC_STORAGE_KEY, password);
      this._subscribe();
      // updatedAt is returned so the caller can compare it against its own
      // locally stored timestamp before overwriting local state (last write wins).
      return { ok: true, firstSetup: false, state, updatedAt: remote.updatedAt || 0 };
    } catch (e) {
      return { ok: false };
    }
  },

  _saltB64() {
    return this._salt ? bytesToBase64(this._salt) : null;
  },

  _failKeyMismatch(detail) {
    this._stopped = true;
    clearTimeout(this._pushTimer);
    if (this._onPushStatus) this._onPushStatus(false);
    if (this._onError) this._onError("key-mismatch: " + (detail || "impossibile decifrare i dati remoti"));
  },

  _subscribe() {
    if (this._subscribed) return;
    this._subscribed = true;
    onValue(ref(this._db, STATE_PATH), async (snap) => {
      const remote = snap.val();
      if (!remote || !this._key || this._stopped) return;
      // Echo suppression is identity-based, never clock-based.
      if (remote.writerId && remote.writerId === this._writerId) return;
      const remoteAt = remote.updatedAt || 0;
      let key = this._key;
      // The /state node may have been deleted and recreated with a fresh salt.
      // Re-derive from the stored password instead of failing forever.
      const saltChanged = !!remote.salt && remote.salt !== this._saltB64();
      if (saltChanged) {
        const stored = localStorage.getItem(SYNC_STORAGE_KEY);
        if (!stored) { this._failKeyMismatch("nessuna password salvata"); return; }
        try {
          key = await deriveKey(stored, base64ToBytes(remote.salt));
        } catch (e) {
          this._failKeyMismatch(e.message);
          return;
        }
      } else if (remoteAt <= (this._lastAppliedAt || 0)) {
        return;
      }
      try {
        const state = await decryptPayload(key, remote);
        // Re-check after the await: a newer update may have landed meanwhile.
        const stillNewSalt = !!remote.salt && remote.salt !== this._saltB64();
        if (!stillNewSalt && remoteAt <= (this._lastAppliedAt || 0)) return;
        if (saltChanged) {
          this._salt = base64ToBytes(remote.salt);
          this._key = key;
        }
        this._lastAppliedAt = remoteAt;
        if (this._onRemoteState) this._onRemoteState(state, remoteAt);
      } catch (e) {
        if (saltChanged) this._failKeyMismatch(e.message);
        else if (this._onError) this._onError("decrypt: " + e.message);
      }
    }, (e) => {
      if (this._onError) this._onError("subscribe: " + e.message);
    });
  },

  schedulePush(state) {
    if (!this._key || this._stopped) return;
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => { this._writeRemote(state); }, 800);
  },

  // Returns the updatedAt it wrote, or 0 if the write failed.
  async _writeRemote(state) {
    if (!this._key || this._stopped) return 0;
    const updatedAt = Date.now();
    try {
      const payload = await encryptPayload(this._key, this._salt, state, updatedAt, this._writerId);
      await set(ref(this._db, STATE_PATH), payload);
      // _lastAppliedAt deliberately tracks only *applied remote* payloads: our own
      // echo is suppressed by writerId, so a fast local clock can no longer make
      // this device ignore its peers.
      if (this._onPushStatus) this._onPushStatus(true);
      return updatedAt;
    } catch (e) {
      if (this._onPushStatus) this._onPushStatus(false);
      if (this._onError) this._onError("write: " + (e && e.message ? e.message : e));
      return 0;
    }
  }
};

// NB: `window.SyncManager` is a *native* browser global (the Background Sync API
// interface), so it stays truthy even when this module never loads — a presence
// check on that name silently reached methods that do not exist. This manager is
// therefore published under its own name.
window.EnotikiSync = SyncManager;
window.dispatchEvent(new Event("enotiki-sync-ready"));

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

async function encryptPayload(key, saltBytes, stateObj, updatedAt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(stateObj));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    ciphertext: bytesToBase64(new Uint8Array(cipherBuf)),
    iv: bytesToBase64(iv),
    salt: bytesToBase64(saltBytes),
    updatedAt
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
  _lastAppliedAt: 0,
  _pushTimer: null,
  _onRemoteState: null,
  _onError: null,

  init(onRemoteState, onError) {
    this._onRemoteState = onRemoteState;
    this._onError = onError;
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
      localStorage.setItem(SYNC_STORAGE_KEY, password);
      await this._writeRemote(currentLocalState);
      this._subscribe();
      return { ok: true, firstSetup: true };
    }
    const salt = base64ToBytes(remote.salt);
    const key = await deriveKey(password, salt);
    try {
      const state = await decryptPayload(key, remote);
      this._salt = salt;
      this._key = key;
      this._lastAppliedAt = remote.updatedAt || 0;
      localStorage.setItem(SYNC_STORAGE_KEY, password);
      this._subscribe();
      return { ok: true, firstSetup: false, state };
    } catch (e) {
      return { ok: false };
    }
  },

  _subscribe() {
    onValue(ref(this._db, STATE_PATH), async (snap) => {
      const remote = snap.val();
      if (!remote || !this._key) return;
      if (remote.updatedAt && remote.updatedAt <= this._lastAppliedAt) return;
      try {
        const state = await decryptPayload(this._key, remote);
        this._lastAppliedAt = remote.updatedAt;
        if (this._onRemoteState) this._onRemoteState(state);
      } catch (e) {
        if (this._onError) this._onError("decrypt: " + e.message);
      }
    });
  },

  schedulePush(state) {
    if (!this._key) return;
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => this._writeRemote(state), 800);
  },

  async _writeRemote(state) {
    const updatedAt = Date.now();
    const payload = await encryptPayload(this._key, this._salt, state, updatedAt);
    this._lastAppliedAt = updatedAt;
    await set(ref(this._db, STATE_PATH), payload);
  }
};

window.SyncManager = SyncManager;
window.dispatchEvent(new Event("enotiki-sync-ready"));

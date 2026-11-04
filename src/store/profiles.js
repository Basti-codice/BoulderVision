// Board profiles in IndexedDB: wall size, corners, holds, LED mapping and a snapshot of the wall.
const DB = 'bouldervision', STORE = 'profiles';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const tx = async (mode, fn) => {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode), st = t.objectStore(STORE), req = fn(st);
    t.oncomplete = () => { db.close(); res(req?.result); };
    t.onerror = () => { db.close(); rej(t.error); };
  });
};

export const listProfiles = async () => (await tx('readonly', (s) => s.getAll())).map(({ id, name, updated, holdCount }) => ({ id, name, updated, holdCount })).sort((a, b) => b.updated - a.updated);
export const loadProfile = (id) => tx('readonly', (s) => s.get(id));
export const saveProfile = (p) => tx('readwrite', (s) => s.put({ ...p, updated: Date.now() }));
export const deleteProfile = (id) => tx('readwrite', (s) => s.delete(id));
export const newId = () => 'p' + Math.random().toString(36).slice(2, 9);

/** JSON export/import (snapshot blob is embedded as a data URL). */
export async function exportProfile(p) {
  let snapshot = null;
  if (p.snapshot instanceof Blob) snapshot = await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(p.snapshot); });
  return JSON.stringify({ format: 'bouldervision-profile', version: 1, ...p, snapshot }, null, 1);
}
export async function importProfile(text) {
  const o = JSON.parse(text);
  if (o.format !== 'bouldervision-profile') throw new Error('Not a BoulderVision profile file.');
  if (typeof o.snapshot === 'string') o.snapshot = await (await fetch(o.snapshot)).blob();
  o.id = newId();
  return o;
}

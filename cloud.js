// Camada de nuvem do Heryn Mapas: login (Firebase Auth) e mapas (Firestore).
// Estrutura no Firestore, tudo dentro do usuário dono:
//   users/{uid}/maps/{id}     -> { title, updated }   (leve, usado na lista)
//   users/{uid}/mapData/{id}  -> { json }             (a árvore inteira, como texto JSON)
// A árvore vai como texto porque o Firestore limita a profundidade de objetos aninhados.
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut, GoogleAuthProvider, signInWithPopup,
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, onSnapshot, writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

export const configured = !!firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith('COLE');

let auth = null, db = null, uid = null;
if (configured) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  auth.languageCode = 'pt-BR';
  db = getFirestore(app);
}

const ERRORS = {
  'auth/invalid-email': 'E-mail inválido.',
  'auth/missing-password': 'Digite a senha.',
  'auth/invalid-credential': 'E-mail ou senha incorretos.',
  'auth/wrong-password': 'E-mail ou senha incorretos.',
  'auth/user-not-found': 'E-mail ou senha incorretos.',
  'auth/email-already-in-use': 'Esse e-mail já tem conta. Use "Entrar".',
  'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.',
  'auth/too-many-requests': 'Muitas tentativas. Aguarde um pouco e tente de novo.',
  'auth/network-request-failed': 'Sem conexão com a internet.',
  'auth/admin-restricted-operation': 'O cadastro de novas contas está desativado.',
  'auth/operation-not-allowed': 'Esse método de login não está ativado no Firebase.',
  'auth/popup-closed-by-user': '',
  'auth/cancelled-popup-request': '',
  'auth/unauthorized-domain': 'Este domínio não está autorizado no Firebase (Authentication → Settings → Authorized domains).',
};
export const errorMessage = err => (err && err.code in ERRORS ? ERRORS[err.code] : `Não foi possível concluir (${err?.code || err?.message || 'erro'}).`);

/* ---------- login ---------- */
export const onUser = cb => onAuthStateChanged(auth, u => {
  uid = u ? u.uid : null;
  cb(u ? { uid: u.uid, email: u.email } : null);
});
export const signIn = (email, pw) => signInWithEmailAndPassword(auth, email, pw);
export const signUp = (email, pw) => createUserWithEmailAndPassword(auth, email, pw);
export const signInGoogle = () => signInWithPopup(auth, new GoogleAuthProvider());
export const resetPassword = email => sendPasswordResetEmail(auth, email);
export const logout = () => signOut(auth);

/* ---------- mapas ---------- */
const metaRef = id => doc(db, 'users', uid, 'maps', id);
const dataRef = id => doc(db, 'users', uid, 'mapData', id);
export const newId = () => doc(collection(db, 'users', uid, 'maps')).id;

// cb(lista, veioDoCache). A lista vem ordenada do mais recente para o mais antigo.
export function watchMaps(cb, onError) {
  return onSnapshot(collection(db, 'users', uid, 'maps'), { includeMetadataChanges: true }, snap => {
    const list = snap.docs.map(d => ({ id: d.id, title: d.data().title || '', updated: d.data().updated || 0 }));
    list.sort((a, b) => b.updated - a.updated);
    cb(list, snap.metadata.fromCache);
  }, onError);
}

export async function loadMap(id) {
  const [meta, data] = await Promise.all([getDoc(metaRef(id)), getDoc(dataRef(id))]);
  if (!meta.exists() || !data.exists()) return null;
  return { id, title: meta.data().title, updated: meta.data().updated, root: JSON.parse(data.data().json) };
}

export async function saveMap(m) {
  const batch = writeBatch(db);
  batch.set(metaRef(m.id), { title: m.title, updated: m.updated });
  batch.set(dataRef(m.id), { json: JSON.stringify(m.root) });
  await batch.commit();
}

export async function removeMap(id) {
  const batch = writeBatch(db);
  batch.delete(metaRef(id));
  batch.delete(dataRef(id));
  await batch.commit();
}

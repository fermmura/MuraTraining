/* ===================================================================
   Meu Treino — app standalone (Firebase Auth + Firestore, offline-first)
   =================================================================== */

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// habilita cache offline (o navegador guarda os dados e sincroniza
// automaticamente quando a internet voltar)
db.enablePersistence({ synchronizeTabs: true }).catch(() => {
  // se falhar (ex.: várias abas abertas em navegadores antigos), o app
  // ainda funciona normalmente, só perde o cache offline
});

const uid = () => Math.random().toString(36).slice(2, 10);
let lastSeenRecorded = false;

const el = (id) => document.getElementById(id);
const appEl = document.getElementById("app");

// ---------- personalização de tema ----------

const DEFAULT_THEME = {
  bg: "#17161A", panel: "#211F25", panelAlt: "#2A2830", line: "#3A3742",
  chalk: "#F3EFE6", muted: "#9A94A6", red: "#FF4433", redDim: "#5C2620",
  steel: "#4C86B4", plate: "#E8B94A",
  fontDisplay: "Anton", fontBody: "Inter",
};

const FONT_DISPLAY_OPTIONS = ["Anton", "Bebas Neue", "Oswald", "Poppins", "Montserrat"];
const FONT_BODY_OPTIONS = ["Inter", "Roboto", "Work Sans", "Nunito Sans", "Poppins"];

function applyTheme(theme) {
  const root = document.documentElement;
  const t = { ...DEFAULT_THEME, ...theme };
  ["bg", "panel", "panelAlt", "line", "chalk", "muted", "red", "redDim", "steel", "plate"].forEach((k) => {
    root.style.setProperty("--" + k, t[k]);
  });
  root.style.setProperty("--font-display", `'${t.fontDisplay}', 'Inter', sans-serif`);
  root.style.setProperty("--font-body", `'${t.fontBody}', system-ui, sans-serif`);
}

let publishedTheme = { ...DEFAULT_THEME };
async function loadPublishedTheme() {
  try {
    const snap = await db.collection("settings").doc("theme").get();
    if (snap.exists && snap.data().published) {
      publishedTheme = { ...DEFAULT_THEME, ...snap.data().published };
      applyTheme(publishedTheme);
    }
  } catch (e) {
    // sem tema salvo ainda, ou sem internet — segue com o padrão
  }
}
loadPublishedTheme();

let currentUser = null; // objeto do Firebase Auth
let isTrainer = false;
let clients = []; // só preenchido para o treinador
let myClient = null; // só preenchido para o aluno
let unsubscribe = null;

let ui = { view: "loading", selectedId: null, activeDayId: null, progOpen: false, progMode: "evolucao", progKey: null, progPeriod: "tudo", progGroup: "todos", progQ: "", progListOpen: false, progSel: null, progMenu: null, studentEnteredTreinos: false, calendarOpen: false, planWeekKey: null, planSaveState: "idle", planSavedAt: null, themeOpen: false, cardioOpen: false, feedbackOpen: false, muscleOpen: false, pastWeekKey: null };
let draggedDayId = null;
let pendingPlanEdit = null; // rascunho do plano de semana futura em edição { clientId, planId, days }
let renderQueuedFromSync = false; // redesenho adiado porque havia um campo em uso
let lastDoneIndexCache = { key: "", map: new Map() }; // refeito a cada desenho da tela
let collapsedEx = {}; // exercícios minimizados; por padrão, todo exercício começa minimizado
let openNotes = {}; // observações do aluno abertas manualmente nessa sessão
const isCollapsed = (exId) => collapsedEx[exId] !== false;

// ---------- autenticação ----------

auth.onAuthStateChanged((user) => {
  currentUser = user;
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }

  if (!user) {
    ui = { view: "gate", mode: "login", error: "" };
    render();
    return;
  }

  isTrainer = user.email.toLowerCase() === TRAINER_EMAIL.toLowerCase();

  if (isTrainer) {
    ui = { view: "trainer", selectedId: null, activeDayId: null };
    unsubscribe = db.collection("clients").onSnapshot(
      (snap) => {
        clients = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        // o plano de semana futura que está sendo montado agora só existe na
        // memória — reaplica ele por cima dos dados que acabaram de chegar,
        // senão cada série que o aluno registra apaga o planejamento em curso
        reapplyPendingPlanEdit();
        clients.forEach((c) => maybePromoteWeek(c, snap.metadata.fromCache));
        renderFromSync();
      },
      (e) => handleSyncError(e)
    );
  } else {
    ui = { view: "student", activeDayId: null };
    unsubscribe = db
      .collection("clients")
      .where("email", "==", user.email.toLowerCase())
      .onSnapshot(
        (snap) => {
          myClient = snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
          if (myClient) {
            maybePromoteWeek(myClient, snap.metadata.fromCache);
            if (!lastSeenRecorded) {
              lastSeenRecorded = true;
              db.collection("clients").doc(myClient.id).update({ lastSeen: Date.now() }).catch(() => {});
            }
          }
          renderFromSync();
        },
        (e) => handleSyncError(e)
      );
  }
  render();

  if (lastTypedLogin) {
    const pendingLogin = lastTypedLogin;
    lastTypedLogin = null;
    setTimeout(() => maybeOfferFaceId(pendingLogin), 400);
  }
});

let lastTypedLogin = null; // guarda o que a pessoa digitou, pra poder oferecer Face ID depois de logar

function doLogin(email, password) {
  lastTypedLogin = { email, password };
  auth.signInWithEmailAndPassword(email, password).catch((e) => {
    ui.error = traduzErro(e.code);
    render();
  });
}

function doLogout() {
  stopWorkoutClock();
  ui.studentEnteredTreinos = false;
  auth.signOut();
}

// ---------- Face ID / Touch ID (atalho local no aparelho, sem servidor) ----------

function faceIdSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials);
}

async function registerFaceId(email, password) {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: "Meu Treino", id: location.hostname },
      user: { id: userId, name: email, displayName: email },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
      timeout: 60000,
    },
  });
  const credId = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)));
  localStorage.setItem("mt_faceid_cred", credId);
  localStorage.setItem("mt_faceid_email", email);
  localStorage.setItem("mt_faceid_password", password);
}

async function tryFaceIdLogin() {
  const credId = localStorage.getItem("mt_faceid_cred");
  if (!credId) return;
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const rawId = Uint8Array.from(atob(credId), (c) => c.charCodeAt(0));
  try {
    await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: rawId, type: "public-key" }],
        userVerification: "required",
        timeout: 60000,
      },
    });
    const email = localStorage.getItem("mt_faceid_email");
    const password = localStorage.getItem("mt_faceid_password");
    if (email && password) doLogin(email, password);
  } catch (e) {
    ui.error = "Não foi possível confirmar. Use email e senha.";
    render();
  }
}

function forgetFaceId() {
  localStorage.removeItem("mt_faceid_cred");
  localStorage.removeItem("mt_faceid_email");
  localStorage.removeItem("mt_faceid_password");
}

function maybeOfferFaceId(login) {
  if (!faceIdSupported()) return;
  if (localStorage.getItem("mt_faceid_cred")) return; // já ativado nesse aparelho
  if (!login) return;
  const banner = document.getElementById("install-banner");
  if (!banner) return;
  if (localStorage.getItem("mt_faceid_dismissed") === "1") return;

  banner.classList.remove("hidden");
  banner.innerHTML = `<span>Ativar Face ID/Touch ID nesse aparelho pra entrar sem digitar senha da próxima vez?</span>
    <button id="fid-yes">Ativar</button>
    <button id="fid-no"><i class="ti ti-x"></i></button>`;
  document.getElementById("fid-yes").onclick = async () => {
    try {
      await registerFaceId(login.email, login.password);
    } catch (e) {
      // aparelho sem suporte ou usuário cancelou — sem problema, só ignora
    }
    banner.classList.add("hidden");
  };
  document.getElementById("fid-no").onclick = () => {
    localStorage.setItem("mt_faceid_dismissed", "1");
    banner.classList.add("hidden");
  };
}

function traduzErro(code) {
  if (code === "auth/invalid-email") return "Email inválido";
  if (code === "auth/user-not-found" || code === "auth/wrong-password" || code === "auth/invalid-credential")
    return "Email ou senha incorretos";
  if (code === "auth/too-many-requests") return "Muitas tentativas. Tente de novo em instantes.";
  if (code === "auth/email-already-in-use") return "Esse email já tem uma conta";
  if (code === "auth/weak-password") return "Senha muito curta (mínimo 6 caracteres)";
  return "Erro: " + code;
}

// ---------- treinador: criar aluno (conta + ficha) ----------
// usa uma instância secundária do Firebase para criar a conta do aluno
// sem derrubar a sessão do treinador
async function createStudent(name, email, password, copyDaysFrom) {
  const secondary = firebase.apps.find((a) => a.name === "Secondary") || firebase.initializeApp(firebaseConfig, "Secondary");
  const secAuth = secondary.auth();
  const cred = await secAuth.createUserWithEmailAndPassword(email.toLowerCase(), password);
  await secAuth.signOut();

  const days = copyDaysFrom ? cloneDaysWithNewIds(copyDaysFrom) : [];

  await db.collection("clients").doc(cred.user.uid).set({
    name,
    email: email.toLowerCase(),
    password, // guardado só pra você conseguir consultar/copiar depois; só você (e o próprio aluno) enxergam isso
    goal: "",
    days,
    createdAt: Date.now(),
  });
}

// um cronômetro de treino nunca dura mais que algumas horas. Se sobrou um
// `timerStartedAt` antigo (ex.: o app fechou no meio do treino, ou o campo veio
// junto numa cópia de semana), ele não pode continuar aparecendo como "em
// andamento" pra sempre — depois desse limite tratamos como treino não iniciado.
const MAX_WORKOUT_MS = 6 * 60 * 60 * 1000; // 6 horas
function isTimerRunning(day) {
  if (!day || !day.timerStartedAt) return false;
  return Date.now() - day.timerStartedAt < MAX_WORKOUT_MS;
}

// clona os dias de treino, gerando ids novos pra tudo (dias, exercícios e
// séries), sem carregar nenhum histórico/progresso junto.
// Quando `photoPairs` é passado, os exercícios que tinham foto entram na lista
// como { from: idAntigo, to: idNovo } — quem chamou usa isso pra copiar as
// fotos pros ids novos (veja `clonePhotosForNewIds`).
// `carryGhost`: usado quando a cópia é a SEMANA SEGUINTE do mesmo aluno. O
// "feito" sempre zera (semana nova começa do zero, e o contador de séries
// feitas também), mas o número da última vez que ele realmente fez aquela
// série fica guardado em `prevReps` — é o que aparece esmaecido ao fundo do
// campo, como referência. Se a série não foi feita na semana que passou, a
// referência anterior continua valendo (sempre o ÚLTIMO treino feito).
function cloneDaysWithNewIds(days, resetDone = true, photoPairs = null, carryGhost = false) {
  // as marcas do treino curto valem só pra semana em que o aluno as fez
  return resetWeekFlags(days, SEMPRE).map((d) => {
    // `timerStartedAt` é estado da SESSÃO daquele dia, não faz parte do treino —
    // se ele viajar junto pra uma cópia/semana nova, o treino nasce já marcado
    // como "em andamento", com o cronômetro contando desde outro dia.
    const { timerStartedAt, ...dayRest } = d;
    return {
      ...dayRest,
      id: uid(),
      exercises: (d.exercises || []).map((ex) => {
        // a foto fica numa subcoleção à parte, indexada pelo id do exercício.
        // Como aqui geramos um id novo, a foto precisa ser COPIADA pro id novo —
        // senão ela some da semana seguinte.
        const { photoUrl, hasPhoto, ...rest } = ex;
        const newExId = uid();
        const hadPhoto = !!(photoUrl || hasPhoto);
        if (hadPhoto && photoPairs) photoPairs.push({ from: ex.id, to: newExId });
        return {
          ...rest,
          id: newExId,
          ...(hadPhoto && photoPairs ? { hasPhoto: true } : {}),
          sets: (ex.sets || []).map((s) => {
            if (!carryGhost) return { ...s, id: uid(), repsDone: resetDone ? "" : s.repsDone };
            return { ...s, id: uid(), repsDone: "", prevReps: s.repsDone || s.prevReps || "" };
          }),
        };
      }),
    };
  });
}

// copia de verdade as fotos pros ids novos gerados pelo clone acima.
// Devolve os dias já ajustados: se alguma foto não puder ser copiada, a flag
// `hasPhoto` é removida daquele exercício, pra não ficar um quadro quebrado.
async function clonePhotosForNewIds(clientId, clonedDays, photoPairs) {
  if (!photoPairs || photoPairs.length === 0) return clonedDays;
  const copied = new Set();
  for (const pair of photoPairs) {
    try {
      const dataUrl = await loadPhoto(clientId, pair.from);
      if (dataUrl) {
        await savePhoto(clientId, pair.to, dataUrl);
        copied.add(pair.to);
      }
    } catch (e) {
      // sem internet ou foto perdida — segue sem ela
    }
  }
  return clonedDays.map((d) => ({
    ...d,
    exercises: (d.exercises || []).map((ex) => {
      if (!ex.hasPhoto || copied.has(ex.id)) return ex;
      const { hasPhoto, ...rest } = ex;
      return rest;
    }),
  }));
}

// verifica se a semana virou de verdade (no calendário) e, se tiver um plano
// pronto pra essa semana, promove ele automaticamente pra virar o treino atual —
// sem precisar de nenhum clique do treinador
const promotedThisSession = new Set();
// A carga e as repetições do último treino aparecem na tela do plano, mas o que
// vale pro aluno é o que está gravado. Antes de o plano virar a semana atual,
// grava nele as referências — sem isso o treinador vê 42,5 no planejamento e o
// aluno recebe os 40 que vieram da cópia, e o número esmaecido ficaria com o
// que valia quando o plano foi criado, não com o que o aluno fez depois.
function withRefLoads(client, planDays, planWeekKey) {
  // o índice só é refeito quando a tela é redesenhada, e a virada roda antes
  // disso — descarta o que estiver guardado pra não ler um histórico velho
  lastDoneIndexCache = { key: "", map: new Map() };
  const idx = lastDoneIndex(client, planWeekKey);
  if (!idx.size) return planDays;
  return (planDays || []).map((d) => ({
    ...d,
    exercises: (d.exercises || []).map((ex) => ({
      ...ex,
      sets: (ex.sets || []).map((s, i) => {
        const ref = idx.get((ex.name || "") + "|" + i);
        if (!ref) return s;
        const next = { ...s };
        if (ref.repsDone) next.prevReps = ref.repsDone;
        // carga prescrita pelo treinador manda
        if (!s.loadSetByTrainer && ref.load) next.load = ref.load;
        return next;
      }),
    })),
  }));
}

// Virada de semana SEM plano pronto: os `days` continuam sendo fisicamente os
// mesmos, com o "feito" da semana passada colado. Zera o "feito" e guarda o
// número em `prevReps`, que a tela mostra esmaecido até o aluno digitar o novo.
// Não perde nada: o número só muda de campo, e o histórico não é tocado.
// Série que o aluno JÁ registrou na semana nova (tem entrada no histórico com
// weekKey igual ou maior) fica como está.
function withDoneReset(client, days, newWeekKey) {
  const doneThisWeek = new Set();
  for (const h of client.history || []) {
    if (h.setId && h.repsDone && h.weekKey && h.weekKey >= newWeekKey) doneThisWeek.add(h.setId);
  }
  return resetWeekFlags(days, newWeekKey).map((d) => ({
    ...d,
    exercises: (d.exercises || []).map((ex) => ({
      ...ex,
      sets: (ex.sets || []).map((s) => {
        if (!s.repsDone || doneThisWeek.has(s.id)) return s;
        return { ...s, repsDone: "", prevReps: s.repsDone };
      }),
    })),
  }));
}

function hasAnyRepsDone(days) {
  return (days || []).some((d) => (d.exercises || []).some((ex) => (ex.sets || []).some((s) => s.repsDone)));
}

// Marcas que só valem na semana em que foram feitas: o aluno ligou o treino
// curto (`day.shortOn`) ou reativou um exercício (`ex.shortKeep`). Guardam a
// semana em que foram marcadas, então a virada só apaga as de semanas
// anteriores — uma marca feita já na semana nova (virada que chegou atrasada)
// fica como está. Pra apagar tudo (cópia pra semana seguinte ou outro aluno),
// passe `SEMPRE`.
const SEMPRE = "9999-12-31";
const flagIsStale = (v, newWeekKey) => typeof v !== "string" || v < newWeekKey;

function resetWeekFlags(days, newWeekKey) {
  return (days || []).map((d) => {
    const { shortOn, ...dayRest } = d;
    return {
      ...dayRest,
      ...(shortOn && !flagIsStale(shortOn, newWeekKey) ? { shortOn } : {}),
      exercises: (d.exercises || []).map((ex) => {
        const { shortKeep, ...rest } = ex;
        return shortKeep && !flagIsStale(shortKeep, newWeekKey) ? { ...rest, shortKeep } : rest;
      }),
    };
  });
}

function hasWeekFlags(days) {
  return (days || []).some((d) => d.shortOn || (d.exercises || []).some((ex) => ex.shortKeep));
}

// semana do último registro do aluno, ignorando semanas futuras (registros
// gravados com a data errada pelo bug antigo do fuso). Serve pra descobrir de
// que semana são os `days` quando a ficha não tem `activeWeekKey`.
function latestHistoryWeekKey(client, currentKey) {
  let latest = "";
  for (const h of client.history || []) {
    if (h.weekKey && h.weekKey <= currentKey && h.weekKey > latest) latest = h.weekKey;
  }
  return latest;
}

async function maybePromoteWeek(client, fromCache = false) {
  // Nunca vira a semana a partir de dados que vieram só do cache do aparelho:
  // a virada regrava `days` inteiro, e uma cópia velha (aparelho que ficou
  // offline) apagaria o que o treinador ou o aluno mexeram nesse meio tempo.
  // Quando o servidor responde, o snapshot seguinte chega sem `fromCache` e a
  // virada acontece nessa hora.
  if (fromCache) return;
  const currentKey = weekKeyOf(todayKey());
  // ficha sem `activeWeekKey` (criada direto, sem nunca ter aberto uma semana
  // futura): antes a semana nunca virava. Agora deduz de que semana são os
  // `days` pelo último registro; sem histórico, só carimba a semana de hoje.
  const activeKey = client.activeWeekKey || latestHistoryWeekKey(client, currentKey) || currentKey;
  if (currentKey < activeKey) return; // segurança: nunca "volta" a semana
  if (currentKey === activeKey && client.activeWeekKey) return; // nada a fazer
  const sessionFlag = client.id + ":" + currentKey;
  if (promotedThisSession.has(sessionFlag)) return;
  promotedThisSession.add(sessionFlag);

  const plans = client.weekPlans || [];
  const plan = plans.find((p) => p.weekKey === currentKey);
  try {
    let patch;
    if (currentKey === activeKey) {
      // só faltava a etiqueta da semana
      patch = { activeWeekKey: currentKey };
    } else if (plan) {
      const nextPlans = plans.filter((p) => p.id !== plan.id);
      // limpeza: planos salvos antes da correção podem ter vindo com o
      // cronômetro de outro dia colado neles. A semana nova sempre começa parada.
      const freshDays = resetWeekFlags(withRefLoads(client, plan.days, plan.weekKey), currentKey).map((d) => {
        const { timerStartedAt, ...rest } = d;
        return rest;
      });
      patch = { days: freshDays, activeWeekKey: currentKey, weekPlans: nextPlans };
    } else if (hasAnyRepsDone(client.days) || hasWeekFlags(client.days)) {
      patch = { days: withDoneReset(client, client.days, currentKey), activeWeekKey: currentKey };
    } else {
      // nada pra zerar: não regrava `days`, só troca a etiqueta
      patch = { activeWeekKey: currentKey };
    }
    // se falhar, `saveClient` já avisa; não repete a tentativa a cada
    // atualização (cada falha mostraria o aviso de novo) — tenta na próxima
    // vez que o app for aberto
    await saveClient(client.id, patch);
  } catch (e) {
    promotedThisSession.delete(sessionFlag); // libera pra tentar de novo depois
  }
}

async function removeStudentDoc(clientId) {
  // remove só a ficha de treino (não a conta de login — isso exige o
  // Admin SDK, fora do alcance do app do navegador)
  await db.collection("clients").doc(clientId).delete();
}

// recria o login de um aluno que já existe, com senha nova, sem mandar
// nenhum email — PRÉ-REQUISITO: você precisa ter apagado a conta antiga
// dele no Firebase Console (Authentication > Users > excluir) antes de usar isso,
// senão o Firebase recusa por já existir uma conta com esse email
async function resetStudentLogin(oldClient, newPassword) {
  const secondary = firebase.apps.find((a) => a.name === "Secondary") || firebase.initializeApp(firebaseConfig, "Secondary");
  const secAuth = secondary.auth();
  const cred = await secAuth.createUserWithEmailAndPassword(oldClient.email, newPassword);
  await secAuth.signOut();

  const { id, ...rest } = oldClient;
  await db.collection("clients").doc(cred.user.uid).set({
    ...rest,
    password: newPassword,
  });
  await db.collection("clients").doc(oldClient.id).delete();
}

async function recordClientPassword(clientId, password) {
  // isso só REGISTRA a senha pra ela aparecer na tela — não altera a senha
  // de login de verdade (isso precisa ser feito no Console do Firebase)
  await db.collection("clients").doc(clientId).update({ password });
}

// ---------- leitura/escrita dos dados de treino ----------

// no celular (principalmente iPhone/Safari, no app instalado como PWA),
// o navegador às vezes "derruba" a conexão do cache offline sozinho —
// costuma acontecer quando o app fica em segundo plano um tempo ou o sinal
// cai no meio do treino. O erro técnico é feio e assusta o aluno; em vez de
// mostrar isso cru, oferecemos direto o recarregamento, que resolve.
function isIndexedDbConnectionError(e) {
  const msg = (e && e.message) || "";
  return /IndexedDb|IndexedDB/i.test(msg) && /(unavailable|connection|lost)/i.test(msg);
}
function handleSaveError(e) {
  if (isIndexedDbConnectionError(e)) {
    if (confirm("A conexão do app com o celular caiu por um instante (comum com sinal fraco) — isso não afeta o treino, só é preciso recarregar a página pra voltar a salvar. Recarregar agora?")) {
      location.reload();
    }
    return;
  }
  alert("Erro ao salvar: " + e.message);
}

// mesma ideia, mas pra quando é a sincronização em tempo real que cai (não
// um salvamento específico) — o app fica "parado" sem atualizar sozinho
let syncErrorShown = false;
function handleSyncError(e) {
  if (syncErrorShown) return; // não empilha vários avisos iguais
  syncErrorShown = true;
  if (isIndexedDbConnectionError(e)) {
    if (confirm("A conexão do app com o celular caiu por um instante (comum com sinal fraco) — é preciso recarregar a página pra voltar a sincronizar. Recarregar agora?")) {
      location.reload();
      return;
    }
  } else {
    alert("Erro ao sincronizar com o servidor: " + e.message + "\n\nTente recarregar a página.");
  }
  syncErrorShown = false;
}

function saveClient(id, patch) {
  return db.collection("clients").doc(id).update(patch).then(
    () => true,
    (e) => { handleSaveError(e); return false; }
  );
}

// ---------- fotos dos exercícios ----------
// Cada documento do Firestore tem um limite de 1MB. Guardar as fotos (mesmo
// comprimidas) direto dentro do documento do aluno faz ele estourar esse
// limite conforme mais fotos vão sendo adicionadas ao longo das semanas.
// Por isso cada foto mora no seu PRÓPRIO documento, numa subcoleção
// "photos" do aluno — assim o documento principal do aluno fica sempre
// pequeno, não importa quantas fotos existam.
// O exercício, no documento principal, guarda só a flag `hasPhoto: true`.
const photoCache = new Map(); // "clientId:exId" -> dataUrl (cache em memória, só desta sessão)

function photoCacheKey(clientId, exId) {
  return clientId + ":" + exId;
}

async function savePhoto(clientId, exId, dataUrl) {
  await db.collection("clients").doc(clientId).collection("photos").doc(exId).set({ dataUrl });
  photoCache.set(photoCacheKey(clientId, exId), dataUrl);
}

async function deletePhoto(clientId, exId) {
  photoCache.delete(photoCacheKey(clientId, exId));
  await db.collection("clients").doc(clientId).collection("photos").doc(exId).delete();
}

async function loadPhoto(clientId, exId) {
  const key = photoCacheKey(clientId, exId);
  if (photoCache.has(key)) return photoCache.get(key);
  const snap = await db.collection("clients").doc(clientId).collection("photos").doc(exId).get();
  const dataUrl = snap.exists ? snap.data().dataUrl || "" : "";
  photoCache.set(key, dataUrl);
  return dataUrl;
}

// migração automática: alunos antigos podem ter fotos salvas do jeito antigo
// (embutidas direto no documento) — na primeira vez que o treinador abre a
// ficha dele nesta sessão, movemos essas fotos pra subcoleção e enxugamos o
// documento principal, sem precisar de nenhuma ação manual.
const migratedPhotosThisSession = new Set();
async function migrateLegacyPhotosOnce(client) {
  if (!client || client.__planId) return;
  if (migratedPhotosThisSession.has(client.id)) return;
  migratedPhotosThisSession.add(client.id);

  let changed = false;
  async function migrateDays(days) {
    const next = [];
    for (const d of days || []) {
      const exercises = [];
      for (const ex of d.exercises || []) {
        if (ex.photoUrl) {
          try {
            await savePhoto(client.id, ex.id, ex.photoUrl);
            const { photoUrl, ...rest } = ex;
            exercises.push({ ...rest, hasPhoto: true });
            changed = true;
            continue;
          } catch (e) {
            // se der erro ao migrar, mantém a foto como estava — tenta de novo depois
          }
        }
        exercises.push(ex);
      }
      next.push({ ...d, exercises });
    }
    return next;
  }

  const nextDays = await migrateDays(client.days);
  const nextPlans = [];
  for (const p of client.weekPlans || []) {
    nextPlans.push({ ...p, days: await migrateDays(p.days) });
  }
  if (changed) {
    saveClient(client.id, { days: nextDays, weekPlans: nextPlans });
  }
}

function emptySet() { return { id: uid(), repsGoal: "10", repsDone: "", load: "", intensity: 0, rir: "", rirEnabled: false }; }
function emptyExercise() { return { id: uid(), name: "", notes: "", sets: [emptySet()] }; }

function emptyDay(title) { return { id: uid(), title, exercises: [] }; }

// O plano de semana futura salva sozinho: cada alteração vai pro Firestore
// depois de uma pequena pausa (agrupa mudanças seguidas numa escrita só).
// O rascunho em memória continua existindo porque o app recebe atualizações do
// Firestore o tempo todo e, a cada uma, a lista de alunos é recriada do zero a
// partir do servidor. Entre a edição e a confirmação da escrita cabe uma
// atualização dessas — sem reaplicar o rascunho por cima, a tela voltaria pro
// estado anterior no meio da digitação. Com o aluno treinando chega uma
// atualização a cada série que ele registra, então essa janela é frequente.
function clearPendingPlanEdit() {
  pendingPlanEdit = null;
}

let planSaveTimer = null;
let planSaveSeq = 0;

function hhmmNow() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function schedulePlanSave(clientId) {
  ui.planSaveState = "saving";
  paintPlanStatus();
  if (planSaveTimer) clearTimeout(planSaveTimer);
  planSaveTimer = setTimeout(() => {
    planSaveTimer = null;
    flushPlanSave(clientId);
  }, 600);
}

// cancela uma escrita ainda na fila. Necessário antes de ativar ou apagar o
// plano: sem isso, o save atrasado gravaria `weekPlans` com o plano dentro
// depois da remoção, e ele voltaria do nada.
function cancelPendingPlanSave() {
  if (planSaveTimer) { clearTimeout(planSaveTimer); planSaveTimer = null; }
  planSaveSeq++;
}

async function flushPlanSave(clientId) {
  const parentClient = clients.find((c) => c.id === clientId);
  if (!parentClient) return;
  const seq = ++planSaveSeq;
  const done = saveClient(clientId, { weekPlans: parentClient.weekPlans });
  // sem internet, o Firestore só resolve essa promessa quando reconecta, mas a
  // alteração já está guardada no aparelho e sobe sozinha depois. Por isso o
  // "salvo" aparece na hora; só um erro de verdade muda esse aviso.
  ui.planSaveState = "saved";
  ui.planSavedAt = hhmmNow();
  paintPlanStatus();
  const ok = await done;
  if (seq !== planSaveSeq) return; // já veio outra alteração depois desta
  if (!ok) { ui.planSaveState = "error"; paintPlanStatus(); }
}

// o aviso de status é trocado direto no DOM, sem redesenhar a tela — redesenhar
// a cada tecla tiraria o foco do campo que está sendo preenchido.
function planStatusHTML() {
  if (ui.planSaveState === "saving") {
    return `<span class="status"><span class="dot" style="width:7px;height:7px;border-radius:50%;background:var(--plate);box-shadow:0 0 6px rgba(232,185,74,.6);"></span> Salvando…</span>`;
  }
  if (ui.planSaveState === "error") {
    return `<span class="status"><span class="dot" style="width:7px;height:7px;border-radius:50%;background:var(--red);"></span> Não consegui salvar — verifique a internet</span>`;
  }
  return `<span class="status"><span class="dot" style="width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 6px rgba(99,153,34,.6);"></span> ${ui.planSavedAt ? `Salvo às ${ui.planSavedAt}` : "Tudo salvo"}</span>`;
}

function paintPlanStatus() {
  const node = document.getElementById("plan-status");
  if (node) node.innerHTML = planStatusHTML();
}

function reapplyPendingPlanEdit() {
  if (!pendingPlanEdit) return;
  const parentClient = clients.find((c) => c.id === pendingPlanEdit.clientId);
  if (!parentClient) return; // aluno saiu da lista; mantém guardado
  const plans = parentClient.weekPlans || [];
  if (!plans.some((p) => p.id === pendingPlanEdit.planId)) {
    // o plano não existe mais no servidor (foi ativado ou apagado) — descarta
    pendingPlanEdit = null;
    return;
  }
  parentClient.weekPlans = plans.map((p) =>
    p.id === pendingPlanEdit.planId ? { ...p, days: pendingPlanEdit.days } : p
  );
}

// Cada campo da tela guarda o `client` do último DESENHO da tela. Só que, com
// um campo em uso, o redesenho fica na fila (veja `renderFromSync`) — então ao
// passar de um campo direto pro outro, sem Enter no meio, o segundo campo
// ainda carrega o aluno de ANTES da primeira alteração. Como toda gravação
// manda o array `days` inteiro, a segunda alteração regravava a primeira por
// cima: o que o treinador acabou de escrever "voltava ao normal".
// Antes de gravar, os campos pedem aqui a versão mais nova do aluno, que já
// inclui o que foi salvo um instante atrás.
function latestClient(client) {
  if (!client) return client;
  if (client.__planId) {
    // plano de semana futura: o rascunho em memória é o mais novo de todos
    if (pendingPlanEdit && pendingPlanEdit.clientId === client.id && pendingPlanEdit.planId === client.__planId) {
      return { ...client, days: pendingPlanEdit.days };
    }
    const parent = clients.find((c) => c.id === client.id);
    const plan = parent && (parent.weekPlans || []).find((p) => p.id === client.__planId);
    return plan ? { ...client, days: plan.days } : client;
  }
  const fresh = isTrainer ? clients.find((c) => c.id === client.id) : myClient && myClient.id === client.id ? myClient : null;
  return fresh || client;
}

function updateDays(client, nextDays) {
  if (client.__planId) {
    // editando um plano de semana futura: atualiza a cópia local e manda salvar
    const parentClient = clients.find((c) => c.id === client.id);
    if (parentClient) {
      const nextPlans = (parentClient.weekPlans || []).map((p) =>
        p.id === client.__planId ? { ...p, days: nextDays } : p
      );
      parentClient.weekPlans = nextPlans;
      pendingPlanEdit = { clientId: client.id, planId: client.__planId, days: nextDays };
      schedulePlanSave(client.id);
      renderFromSync();
    }
    return;
  }
  saveClient(client.id, { days: nextDays });
}

// ---------- render ----------

// Redesenhar a tela recria todos os campos do zero. Se isso acontecer no meio
// de uma digitação, o campo perde o foco e o que estava sendo escrito se perde.
// Atualizações vindas do servidor são frequentes (cada série que o aluno
// registra gera uma), então quando há um campo em uso o redesenho fica na fila
// e acontece assim que ele é liberado.
function isTypingInApp() {
  const ae = document.activeElement;
  if (!ae) return false;
  if (ae.tagName !== "INPUT" && ae.tagName !== "TEXTAREA") return false;
  return !!ae.closest("#app");
}

function renderFromSync() {
  if (isTypingInApp()) {
    renderQueuedFromSync = true;
    return;
  }
  render();
}

document.addEventListener("focusout", () => {
  if (!renderQueuedFromSync) return;
  // pequena espera: se o foco só pulou pra outro campo, continua na fila
  setTimeout(() => {
    if (!renderQueuedFromSync || isTypingInApp()) return;
    render();
  }, 150);
});

// Um campo só é salvo quando PERDE o foco (o evento `change`). Só que
// redesenhar a tela apaga todos os campos de uma vez, e um campo apagado com o
// cursor ainda dentro nunca chega a disparar esse evento: o que foi digitado
// some sem aviso nenhum. É o caso de digitar a carga e sair da tela logo em
// seguida — no celular acontece fácil, porque tocar num botão nem sempre tira
// o foco do campo antes de o botão agir.
// Então, antes de apagar a tela, o campo em edição é confirmado na mão.
let committingField = false;

function commitFocusedField() {
  if (committingField) return; // salvar pode redesenhar; não entra em looping
  const ae = document.activeElement;
  if (!ae || (ae.tagName !== "INPUT" && ae.tagName !== "TEXTAREA")) return;
  if (!ae.closest || !ae.closest("#app")) return;
  committingField = true;
  try {
    // tirar o foco é o que faz o navegador disparar o "change" — e ele dispara
    // uma vez só, e só se o valor tiver mudado mesmo. Chamar o salvamento na
    // mão aqui gravaria duas vezes (uma agora, outra no `change` que viria
    // depois), e gravação sobrando é exatamente o que faz um aparelho
    // atropelar o outro.
    ae.blur();
  } catch (e) {
    // não segura o redesenho por causa de uma falha ao salvar
  } finally {
    committingField = false;
  }
}

// fechar, minimizar ou trocar de aba também apaga o que estava sendo digitado
document.addEventListener("visibilitychange", () => { if (document.hidden) commitFocusedField(); });
window.addEventListener("pagehide", () => commitFocusedField());

// Tocar numa área vazia da tela confirma o campo em edição. No computador o
// clique fora já tira o foco sozinho, mas no iPhone tocar numa área sem nada
// não tira: o teclado continua aberto e o `change` (que é quem grava) só
// dispara mais tarde, de surpresa — daí a sensação de que só o Enter salva.
// A confirmação espera um instante DEPOIS do toque, pra o clique de um botão
// ou de um cartão acontecer antes e nunca se perder por causa de um redesenho.
document.addEventListener("pointerup", (e) => {
  const field = document.activeElement;
  if (!field || (field.tagName !== "INPUT" && field.tagName !== "TEXTAREA")) return;
  if (!field.closest || !field.closest("#app")) return;
  const t = e.target;
  // tocar em outro campo ou em algo clicável segue o caminho normal
  if (!t || !t.closest || t.closest("input, textarea, select, button, a, label, [data-feitoopen], .cal-row")) return;
  setTimeout(() => {
    if (document.activeElement !== field) return; // já foi confirmado por outro caminho
    const mudou = field.value !== field.defaultValue;
    commitFocusedField();
    if (mudou) showSavedToast();
  }, 60);
});

// Enter confirma o que está sendo digitado, no computador e no celular.
// Quem grava é o evento `change`, e ele só acontece quando o campo perde o
// foco — então o Enter tira o foco, o que de quebra fecha o teclado do
// celular. Em observações (textarea) o Enter continua pulando linha; ali
// confirma com Ctrl+Enter (ou Cmd+Enter no Mac).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const t = e.target;
  if (!t || !t.closest || !t.closest("#app")) return;
  const isTextarea = t.tagName === "TEXTAREA";
  if (!isTextarea && t.tagName !== "INPUT") return;
  if (isTextarea && !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const mudou = t.value !== t.defaultValue;
  t.blur(); // dispara o `change`, que grava
  if (mudou) showSavedToast();
});

// O aviso vive FORA do #app de propósito: gravar pode redesenhar a tela, e o
// redesenho apaga tudo que está lá dentro — inclusive o próprio aviso.
let savedToastTimer = null;
function showSavedToast() {
  let t = document.getElementById("saved-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "saved-toast";
    t.textContent = "salvo";
    document.body.appendChild(t);
  }
  t.classList.add("on");
  if (savedToastTimer) clearTimeout(savedToastTimer);
  savedToastTimer = setTimeout(() => t.classList.remove("on"), 1200);
}

function render() {
  commitFocusedField();
  renderQueuedFromSync = false;
  // o índice do último treino vale só para este desenho: se o aluno corrigir
  // uma série já registrada, o histórico muda de conteúdo sem mudar de tamanho,
  // e um cache que sobrevivesse ao redesenho mostraria o número velho
  lastDoneIndexCache = { key: "", map: new Map() };
  appEl.innerHTML = "";
  if (ui.view === "loading") { appEl.innerHTML = loadingHTML(); return; }
  if (ui.view === "gate") { appEl.innerHTML = gateHTML(); wireGate(); return; }
  if (ui.view === "trainer") { appEl.innerHTML = trainerHTML(); wireTrainer(); return; }
  if (ui.view === "student") {
    appEl.innerHTML = studentHTML();
    el("btn-logout").onclick = doLogout;
    if (myClient && !ui.studentEnteredTreinos && !ui.cardioOpen && !ui.progOpen && !ui.feedbackOpen) {
      const enterBtn = el("enter-treinos");
      if (enterBtn) enterBtn.onclick = () => { ui.studentEnteredTreinos = true; render(); };
      const cardioBtn = el("enter-cardio");
      if (cardioBtn) cardioBtn.onclick = () => { ui.cardioOpen = true; render(); };
      const evolBtn = el("enter-evolucao");
      if (evolBtn) evolBtn.onclick = () => { ui.progOpen = true; render(); };
      const feedbackBtn = el("enter-feedback");
      if (feedbackBtn) feedbackBtn.onclick = () => { markFeedbackReadFor(myClient, "aluno"); ui.feedbackOpen = true; render(); };
    } else {
      wireClientArea(myClient, false);
    }
    return;
  }
}

function loadingHTML() {
  return `<p style="text-align:center;color:var(--muted);padding-top:60px;">Carregando…</p>`;
}

function gateHTML() {
  const hasFaceId = !!localStorage.getItem("mt_faceid_cred");
  return `
    <div class="gate">
      <div class="display" style="font-size:26px;">MEU TREINO</div>
      <p class="muted-note">Entre com o email e a senha que seu personal te enviou.</p>
      ${
        hasFaceId
          ? `<button type="button" id="g-faceid" class="primary" style="display:flex;align-items:center;justify-content:center;gap:8px;">
              <i class="ti ti-face-id"></i> Entrar com Face ID
            </button>
            <button type="button" id="g-faceid-manual" class="muted-note" style="text-decoration:underline;background:none;border:none;">usar email e senha</button>
            <button type="button" id="g-faceid-forget" class="muted-note" style="text-decoration:underline;background:none;border:none;font-size:11px;">não é você? esquecer Face ID nesse aparelho</button>
            <div id="g-manual-wrap" class="hidden" style="display:flex;flex-direction:column;gap:10px;width:100%;max-width:260px;">`
          : ""
      }
      <form id="g-form" autocomplete="on" style="display:flex;flex-direction:column;gap:10px;width:100%;max-width:260px;">
        <input id="g-email" type="email" name="email" placeholder="Email" autocomplete="username" />
        <input id="g-pass" type="password" name="password" placeholder="Senha" autocomplete="current-password" />
        ${ui.error ? `<div class="error">${ui.error}</div>` : ""}
        <button type="submit" class="primary" id="g-submit">ENTRAR</button>
      </form>
      ${hasFaceId ? `</div>` : ""}
    </div>`;
}

function wireGate() {
  const hasFaceId = !!localStorage.getItem("mt_faceid_cred");

  if (hasFaceId) {
    const manualWrap = el("g-manual-wrap");
    el("g-faceid-manual").onclick = () => manualWrap.classList.toggle("hidden");
    el("g-faceid").onclick = () => tryFaceIdLogin();
    el("g-faceid-forget").onclick = () => { forgetFaceId(); render(); };
  }

  const form = el("g-form");
  if (form) {
    form.onsubmit = (e) => {
      e.preventDefault();
      const email = el("g-email").value.trim();
      const pass = el("g-pass").value;
      ui.error = "";
      doLogin(email, pass);
    };
  }
}

function topbarHTML(name, extraBadge) {
  return `
    <div class="topbar">
      <div class="display name">${escapeHTML(name)}</div>
      <div style="display:flex;align-items:center;gap:8px;">
        ${extraBadge ? `<span class="badge">${extraBadge}</span>` : ""}
        <button class="logout" id="btn-logout">Sair</button>
      </div>
    </div>`;
}

// ---------------- TREINADOR ----------------

function trainerHTML() {
  if (ui.themeOpen) return themeHTML();

  const selected = clients.find((c) => c.id === ui.selectedId) || null;
  return `
    ${topbarHTML("Personal", "modo treinador")}
    <div class="layout">
      <div class="sidebar">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <h1 class="display">ALUNOS</h1>
          <button id="open-theme" style="color:var(--muted);font-size:18px;" aria-label="Personalizar visual"><i class="ti ti-palette"></i></button>
        </div>
        <button class="dashed-btn" id="btn-add-client" style="width:100%;justify-content:center;margin-bottom:10px;">+ novo aluno</button>
        <div id="add-client-form" class="hidden" style="display:flex;flex-direction:column;gap:6px;background:var(--panelAlt);padding:8px;border-radius:8px;margin-bottom:10px;">
          <input id="nc-name" placeholder="Nome do aluno" />
          <input id="nc-email" type="email" placeholder="Email do aluno" />
          <input id="nc-pass" placeholder="Senha (mín. 6 caracteres)" />
          <div style="display:flex;justify-content:flex-end;gap:8px;">
            <button id="nc-cancel" style="color:var(--muted);font-size:12px;">cancelar</button>
            <button id="nc-save" style="color:var(--plate);font-size:12px;">salvar</button>
          </div>
        </div>
        <div id="nc-error" class="error" style="font-size:12px;"></div>
        <div style="display:flex;flex-direction:column;gap:2px;max-height:420px;overflow:auto;">
          ${clients.length === 0 ? `<p class="muted-note">Nenhum aluno ainda.</p>` : ""}
          ${clients
            .map((c) => {
              const isSelected = c.id === ui.selectedId;
              return `
            <div class="client-row ${isSelected ? "active" : ""}" data-id="${c.id}">
              <div style="display:flex;align-items:center;gap:6px;">
                <span class="cn" style="flex:1;">${escapeHTML(c.name)}</span>
                <button class="copy-btn" data-copy="${c.id}">copiar login</button>
              </div>
              <span class="ce">${escapeHTML(c.email)}</span>
              <span class="ce" style="display:flex;align-items:center;gap:3px;"><i class="ti ti-clock" style="font-size:10px;"></i> ${timeAgo(c.lastSeen)}</span>
              ${
                isSelected
                  ? `<div style="display:flex;align-items:center;gap:4px;margin-top:2px;">
                      <span style="font-size:11px;color:var(--plate);">senha:</span>
                      <input class="ce pw-input" data-pwinput="${c.id}" value="${attr(c.password || "")}" placeholder="não registrada" style="flex:1;color:var(--plate);" />
                      <button class="copy-btn" data-pwsave="${c.id}">salvar</button>
                    </div>
                    <button class="copy-btn" data-resetlogin="${c.id}" style="margin-top:4px;width:100%;">recriar login com senha nova</button>
                    <button class="copy-btn" data-deleteclient="${c.id}" style="margin-top:4px;width:100%;color:var(--red);border-color:var(--red);">excluir aluno</button>`
                  : ""
              }
            </div>`;
            })
            .join("")}
        </div>
      </div>
      <div class="main">
        ${selected ? clientAreaHTML(selected, true) : `<p class="muted-note" style="text-align:center;padding:60px 0;">Selecione ou adicione um aluno.</p>`}
      </div>
    </div>`;
}

// ---------------- PERSONALIZAÇÃO DE VISUAL ----------------

let draftTheme = null; // carregado do Firestore ao abrir o painel
let previewOn = false;

function colorRow(key, label) {
  return `
    <div class="theme-row">
      <label>${label}</label>
      <input type="color" data-tkey="${key}" value="${draftTheme[key]}" />
    </div>`;
}

function themeHTML() {
  if (!draftTheme) draftTheme = { ...publishedTheme };
  return `
    ${topbarHTML("Personalização", "modo treinador")}
    <div class="main solo" style="max-width:420px;">
      <button class="back" id="theme-back" style="margin-bottom:14px;"><i class="ti ti-chevron-left"></i> Alunos</button>

      <div class="theme-preview-toggle">
        <input type="checkbox" id="theme-preview" ${previewOn ? "checked" : ""} />
        <label for="theme-preview" style="flex:1;">Modo prévia — só você vê essas mudanças até publicar</label>
      </div>

      <p class="muted-note" style="text-transform:uppercase;font-size:11px;font-weight:700;letter-spacing:.05em;margin-bottom:0;">Cores</p>
      ${colorRow("bg", "Fundo")}
      ${colorRow("panel", "Painel")}
      ${colorRow("panelAlt", "Painel (alt)")}
      ${colorRow("line", "Bordas")}
      ${colorRow("chalk", "Texto principal")}
      ${colorRow("muted", "Texto secundário")}
      ${colorRow("red", "Destaque (botões)")}
      ${colorRow("redDim", "Destaque escuro")}
      ${colorRow("steel", "Cor do kg")}
      ${colorRow("plate", "Cor da meta")}

      <p class="muted-note" style="text-transform:uppercase;font-size:11px;font-weight:700;letter-spacing:.05em;margin:16px 0 0;">Fontes</p>
      <div class="theme-row">
        <label>Títulos</label>
        <select id="theme-font-display">
          ${FONT_DISPLAY_OPTIONS.map((f) => `<option value="${f}" ${draftTheme.fontDisplay === f ? "selected" : ""}>${f}</option>`).join("")}
        </select>
      </div>
      <div class="theme-row" style="border-bottom:none;">
        <label>Texto</label>
        <select id="theme-font-body">
          ${FONT_BODY_OPTIONS.map((f) => `<option value="${f}" ${draftTheme.fontBody === f ? "selected" : ""}>${f}</option>`).join("")}
        </select>
      </div>

      <div style="display:flex; flex-direction:column; gap:10px; margin-top:20px;">
        <button class="cta" id="theme-publish">Publicar pros alunos</button>
        <button class="dashed-btn" id="theme-discard" style="justify-content:center;">Descartar alterações</button>
        <button class="dashed-btn" id="theme-reset" style="justify-content:center; color:var(--red); border-color:var(--red);"><i class="ti ti-refresh"></i> Restaurar padrão (aplica na hora)</button>
      </div>
    </div>`;
}

function wireTheme() {
  const backBtn = el("theme-back");
  if (backBtn) backBtn.onclick = () => {
    ui.themeOpen = false;
    previewOn = false;
    applyTheme(publishedTheme); // sai do modo prévia, volta pro que tá publicado
    render();
  };

  const previewCheck = el("theme-preview");
  if (previewCheck) {
    previewCheck.onchange = () => {
      previewOn = previewCheck.checked;
      applyTheme(previewOn ? draftTheme : publishedTheme);
    };
  }

  document.querySelectorAll("[data-tkey]").forEach((input) => {
    input.oninput = () => {
      draftTheme[input.dataset.tkey] = input.value;
      if (previewOn) applyTheme(draftTheme);
    };
  });

  const fontDisplaySelect = el("theme-font-display");
  if (fontDisplaySelect) {
    fontDisplaySelect.onchange = () => {
      draftTheme.fontDisplay = fontDisplaySelect.value;
      if (previewOn) applyTheme(draftTheme);
    };
  }
  const fontBodySelect = el("theme-font-body");
  if (fontBodySelect) {
    fontBodySelect.onchange = () => {
      draftTheme.fontBody = fontBodySelect.value;
      if (previewOn) applyTheme(draftTheme);
    };
  }

  const publishBtn = el("theme-publish");
  if (publishBtn) {
    publishBtn.onclick = async () => {
      publishBtn.textContent = "Publicando…";
      try {
        await db.collection("settings").doc("theme").set({ draft: draftTheme, published: draftTheme }, { merge: true });
        publishedTheme = { ...draftTheme };
        applyTheme(publishedTheme);
        publishBtn.textContent = "Publicado!";
        setTimeout(() => (publishBtn.textContent = "Publicar pros alunos"), 1500);
      } catch (e) {
        publishBtn.textContent = "Erro ao publicar";
      }
    };
  }

  const discardBtn = el("theme-discard");
  if (discardBtn) {
    discardBtn.onclick = () => {
      draftTheme = { ...publishedTheme };
      applyTheme(previewOn ? draftTheme : publishedTheme);
      render();
    };
  }

  const resetBtn = el("theme-reset");
  if (resetBtn) {
    resetBtn.onclick = async () => {
      if (!confirm("Restaurar o visual padrão pra todo mundo agora? Isso publica na hora, sem precisar de prévia.")) return;
      draftTheme = { ...DEFAULT_THEME };
      publishedTheme = { ...DEFAULT_THEME };
      applyTheme(publishedTheme);
      try {
        await db.collection("settings").doc("theme").set({ draft: DEFAULT_THEME, published: DEFAULT_THEME }, { merge: true });
      } catch (e) {
        alert("Restaurado na tela, mas houve um erro ao salvar. Tente de novo com internet.");
      }
      render();
    };
  }
}

function wireTrainer() {
  el("btn-logout").onclick = doLogout;

  if (ui.themeOpen) {
    wireTheme();
    return;
  }

  const openThemeBtn = el("open-theme");
  if (openThemeBtn) openThemeBtn.onclick = () => { ui.themeOpen = true; render(); };

  el("btn-add-client").onclick = () => { el("add-client-form").classList.remove("hidden"); };
  el("nc-cancel").onclick = () => { el("add-client-form").classList.add("hidden"); };
  el("nc-save").onclick = async () => {
    const name = el("nc-name").value.trim();
    const email = el("nc-email").value.trim();
    const pass = el("nc-pass").value;
    el("nc-error").textContent = "";
    if (!name || !email || pass.length < 6) {
      el("nc-error").textContent = "Preencha nome, email e uma senha com 6+ caracteres.";
      return;
    }
    try {
      await createStudent(name, email, pass);
      el("nc-name").value = ""; el("nc-email").value = ""; el("nc-pass").value = "";
      el("add-client-form").classList.add("hidden");
    } catch (e) {
      el("nc-error").textContent = traduzErro(e.code);
    }
  };

  document.querySelectorAll(".client-row").forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest(".copy-btn")) return;
      ui.selectedId = row.dataset.id;
      ui.activeDayId = null;
      render();
    };
  });

  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const c = clients.find((x) => x.id === btn.dataset.copy);
      const senhaTexto = c.password ? `Senha: ${c.password}` : "(a senha é a que você cadastrou ao criar o aluno)";
      navigator.clipboard.writeText(`Email: ${c.email}\n${senhaTexto}`).catch(() => {});
      btn.textContent = "copiado!";
      setTimeout(() => (btn.textContent = "copiar login"), 1200);
    };
  });

  document.querySelectorAll("[data-pwinput]").forEach((input) => {
    input.onclick = (e) => e.stopPropagation();
    input.onkeydown = (e) => e.stopPropagation();
  });

  document.querySelectorAll("[data-pwsave]").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const clientId = btn.dataset.pwsave;
      const input = document.querySelector(`[data-pwinput="${clientId}"]`);
      const value = input.value.trim();
      if (!value) return;
      btn.textContent = "…";
      try {
        await recordClientPassword(clientId, value);
        btn.textContent = "salvo!";
        setTimeout(() => (btn.textContent = "salvar"), 1200);
      } catch (err) {
        btn.textContent = "erro";
        setTimeout(() => (btn.textContent = "salvar"), 1500);
      }
    };
  });

  document.querySelectorAll("[data-resetlogin]").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const clientId = btn.dataset.resetlogin;
      const c = clients.find((x) => x.id === clientId);
      if (!confirm(`Antes de continuar: você já apagou a conta antiga de "${c.name}" no Firebase Console (Authentication > Users)? Se ainda não apagou, cancele e faça isso primeiro.`)) return;
      const newPass = prompt(`Nova senha para ${c.name} (mínimo 6 caracteres):`);
      if (!newPass) return;
      if (newPass.length < 6) { alert("A senha precisa ter pelo menos 6 caracteres."); return; }
      btn.textContent = "recriando…";
      try {
        await resetStudentLogin(c, newPass);
        btn.textContent = "pronto!";
      } catch (err) {
        alert("Erro: " + traduzErro(err.code));
        btn.textContent = "recriar login com senha nova";
      }
    };
  });

  document.querySelectorAll("[data-deleteclient]").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const clientId = btn.dataset.deleteclient;
      const c = clients.find((x) => x.id === clientId);
      const typed = prompt(`Isso apaga TODOS os treinos, histórico e dados de "${c.name}" — não tem como desfazer.\n\nPra confirmar, digite o nome dele exatamente como está: ${c.name}`);
      if (typed !== c.name) {
        if (typed !== null) alert("Nome não bateu. Nada foi apagado.");
        return;
      }
      btn.textContent = "excluindo…";
      try {
        await removeStudentDoc(clientId);
        if (ui.selectedId === clientId) ui.selectedId = null;
      } catch (err) {
        alert("Erro ao excluir: " + err.message);
        btn.textContent = "excluir aluno";
      }
    };
  });

  const selected = clients.find((c) => c.id === ui.selectedId);
  if (selected) wireClientArea(selected, true);
}

// ---------------- ALUNO ----------------

function studentHTML() {
  if (myClient && !ui.studentEnteredTreinos && !ui.cardioOpen && !ui.progOpen && !ui.feedbackOpen) {
    return `
      ${topbarHTML(myClient.name, "modo aluno")}
      <div class="main solo home-screen">
        <div class="home-greet">
          <div class="display" style="font-size:22px;">Olá, "${escapeHTML(myClient.name.split(" ")[0])}"</div>
          <div class="muted-note">como você está hoje?</div>
        </div>

        <button id="enter-treinos" class="home-btn home-btn-lg home-glow-red">
          <i class="ti ti-barbell"></i>
          <span class="display">Musculação</span>
        </button>

        <div class="home-row">
          <button id="enter-cardio" class="home-btn home-glow-blue">
            <i class="ti ti-heart-rate-monitor"></i>
            <span class="display">Cardio</span>
          </button>
          <button id="enter-evolucao" class="home-btn home-glow-gold">
            <i class="ti ti-chart-line"></i>
            <span class="display">Evolução</span>
          </button>
        </div>

        <button id="enter-feedback" class="home-btn home-glow-muted" style="position:relative;">
          <i class="ti ti-message-circle"></i>
          <span class="display">Feedbacks / Observações</span>
          ${hasUnreadFeedbackFor(myClient, "aluno") ? unreadDotHTML() : ""}
        </button>
      </div>`;
  }
  return `
    ${topbarHTML(myClient ? myClient.name : "Meu treino", "modo aluno")}
    <div class="main solo">
      ${
        myClient
          ? clientAreaHTML(myClient, false)
          : `<p class="muted-note" style="text-align:center;padding:60px 0;">Nenhuma ficha de treino vinculada ao seu email ainda. Fale com seu personal.</p>`
      }
    </div>`;
}

// ---------------- ÁREA DE TREINOS (compartilhada treinador/aluno) ----------------

// ---------- relógio ao vivo do cronômetro de treino ----------

let workoutClockInterval = null;

function stopWorkoutClock() {
  if (workoutClockInterval) {
    clearInterval(workoutClockInterval);
    workoutClockInterval = null;
  }
}

function startWorkoutClock() {
  stopWorkoutClock();
  const displayEl = document.getElementById("workout-timer-display");
  if (!displayEl) return;
  const startedAt = Number(displayEl.dataset.started);
  if (!startedAt) return;

  const tick = () => {
    const el2 = document.getElementById("workout-timer-display");
    if (!el2) { stopWorkoutClock(); return; }
    const elapsed = Math.max(0, Date.now() - startedAt);
    const totalSec = Math.floor(elapsed / 1000);
    const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const ss = String(totalSec % 60).padStart(2, "0");
    el2.textContent = `${mm}:${ss}`;
  };
  tick();
  workoutClockInterval = setInterval(tick, 1000);
}

// Treino curto: o treinador marca quais exercícios são `priority`. Quando o
// aluno liga o modo curto do dia (`day.shortOn`), os que não são prioridade
// ficam de fora hoje — sem sair do plano — a não ser que ele reative um por um
// (`ex.shortKeep`). Os dois campos só valem na semana em que foram marcados:
// a virada da semana apaga (veja `resetWeekFlags`).
function exerciseActive(day, ex) {
  return !(day && day.shortOn && !ex.priority && !ex.shortKeep);
}

// `activeOnly`: o aluno vê o contador só do que ele vai fazer hoje (treino curto
// completo = 100%). O treinador vê tudo, pra enxergar o que ficou abaixo do plano.
function dayVolume(day, activeOnly = false) {
  let total = 0, done = 0;
  for (const ex of day.exercises || []) {
    if (activeOnly && !exerciseActive(day, ex)) continue;
    for (const s of ex.sets || []) {
      total++;
      if (s.repsDone) done++;
    }
  }
  return { done, total };
}

const MUSCLE_GROUPS = [
  "Peito", "Costas", "Ombro", "Deltoide posterior", "Trapézio", "Bíceps", "Tríceps", "Antebraço",
  "Quadríceps", "Posterior de coxa", "Glúteo", "Adutores", "Panturrilha", "Abdômen", "Lombar",
];

// tenta adivinhar o grupo muscular pelo nome do exercício (o treinador pode corrigir depois)
// desenhos simples (SVG, brancos) pra cada tipo de treino, escolhidos
// automaticamente pelo nome do dia (ex.: "Lower" ou "Legs" -> desenho de perna)
const DAY_ICONS = {
  leg: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h4l.5 7 2 9h-3l-1.5-7-2 7H6l1.5-9L9 3z"/></svg>`,
  chest: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6c-1.5-2-5-2-6 .5-1 2.5 0 8 2 11 1.5-1 3-2.5 4-4.5 1 2 2.5 3.5 4 4.5 2-3 3-8.5 2-11-1-2.5-4.5-2.5-6-.5z"/></svg>`,
  back: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 4v3c-2 0-3 1-3 3s1 4 3 6l-2 2c-2-1-3.5-3-5-3s-3 2-5 3l-2-2c2-2 3-4 3-6s-1-3-3-3V7l7-4z"/></svg>`,
  shoulder: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="3"/><path d="M4 20c0-4 3-7 8-7s8 3 8 7"/></svg>`,
  arm: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19l3-8c.5-2 2-3 4-3 3 0 5 2 5 5 0 1.5-.5 2.5-1.5 3.2"/><circle cx="9" cy="9" r="2.3"/></svg>`,
  core: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="4" width="10" height="16" rx="3"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="14" x2="17" y2="14"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
  fullbody: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"/><path d="M12 6v7M8 9l4-2 4 2M8 21l4-8 4 8"/></svg>`,
  cardio: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-7 3 14 2-9 1.5 2H21"/></svg>`,
};

function dayIcon(title) {
  const t = (title || "").toLowerCase();
  if (/\b(perna|leg|lower|quadr[íi]ceps|posterior|gl[úu]teo)/.test(t)) return DAY_ICONS.leg;
  if (/\b(peito|push|chest|supino|peitoral)/.test(t)) return DAY_ICONS.chest;
  if (/\b(costas|pull|back|dorsal|puxada|remada)/.test(t)) return DAY_ICONS.back;
  if (/\b(ombro|shoulder|delt[óo]ide)/.test(t)) return DAY_ICONS.shoulder;
  if (/\b(bra[çc]o|biceps|b[íi]ceps|triceps|tr[íi]ceps|arm|upper)/.test(t)) return DAY_ICONS.arm;
  if (/\b(abdomen|abd[ôo]men|core|abs)/.test(t)) return DAY_ICONS.core;
  if (/\b(cardio|corrida|esteira|bike)/.test(t)) return DAY_ICONS.cardio;
  if (/\b(full\s?body|corpo todo)/.test(t)) return DAY_ICONS.fullbody;
  return `<i class="ti ti-barbell" style="font-size:18px;"></i>`;
}

function guessMuscle(name) {
  const n = (name || "").toLowerCase();
  const test = (...words) => words.some((w) => n.includes(w));
  if (test("crucifixo invertido", "crucifixo inverso", "face pull", "remada alta", "elevação posterior", "elevacao posterior", "peck deck invertido", "peckdeck invertido")) return "Deltoide posterior";
  if (test("supino", "peck deck", "peckdeck", "crucifixo", "cross over", "crossover", "voador")) return "Peito";
  if (test("puxada", "remada", "pulldown", "barra fixa", "pull-up", "pulley costas", "levantamento terra", "terra convencional")) return "Costas";
  if (test("desenvolvimento", "elevação lateral", "elevacao lateral", "elevação frontal", "arnold")) return "Ombro";
  if (test("encolhimento", "trapézio", "trapezio")) return "Trapézio";
  if (test("rosca") && !test("rosca inversa punho")) return "Bíceps";
  if (test("tríceps", "triceps", "jm press", "francês", "frances", "testa")) return "Tríceps";
  if (test("punho", "antebraço", "antebraco")) return "Antebraço";
  if (test("panturrilha", "flexão plantar", "flexao plantar")) return "Panturrilha";
  if (test("agachamento", "leg press", "cadeira extensora", "hack", "avanço", "avanco", "afundo")) return "Quadríceps";
  if (test("stiff", "cadeira flexora", "mesa flexora", "flexão de joelho", "flexao de joelho", "flexão nórdica", "flexao nordica")) return "Posterior de coxa";
  if (test("glúteo", "gluteo", "hip thrust", "elevação pélvica", "elevacao pelvica", "coice")) return "Glúteo";
  if (test("adutora", "adutor")) return "Adutores";
  if (test("abdominal", "abs supra", "abs infra", "prancha", "abdômen", "abdomen")) return "Abdômen";
  if (test("lombar", "extensão de tronco", "extensao de tronco", "hiperextensão", "hiperextensao")) return "Lombar";
  return "";
}

// exercícios compostos recrutam um segundo músculo como sinergista — a
// evidência mais recente (Pelland et al., 2025, Sports Medicine) mostra que
// contar essa série sinergista como "meia série" (0.5) é o método que melhor
// prevê o ganho de hipertrofia, comparado a contar cheia ou ignorar
function guessSynergist(name) {
  const n = (name || "").toLowerCase();
  const test = (...words) => words.some((w) => n.includes(w));
  if (test("crucifixo invertido", "crucifixo inverso", "face pull", "remada alta", "elevação posterior", "elevacao posterior")) return "Trapézio";
  if (test("supino", "crucifixo", "cross over", "crossover", "voador") && !test("máquina peito isolad")) return "Tríceps";
  if (test("puxada", "remada", "pulldown", "barra fixa", "pull-up", "pulley costas")) return "Bíceps";
  if (test("desenvolvimento", "arnold")) return "Tríceps";
  if (test("levantamento terra", "terra convencional", "stiff", "hip thrust", "elevação pélvica", "elevacao pelvica")) return "Posterior de coxa";
  if (test("agachamento", "leg press", "hack", "avanço", "avanco", "afundo")) return "Glúteo";
  return "";
}


function fmtVol(n) {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function addMuscleCount(byMuscle, muscle, weight, done) {
  if (!muscle) return;
  if (!byMuscle[muscle]) byMuscle[muscle] = { done: 0, total: 0 };
  byMuscle[muscle].total += weight;
  if (done) byMuscle[muscle].done += weight;
}

function muscleVolume(day, activeOnly = false) {
  const byMuscle = {};
  for (const ex of day.exercises || []) {
    if (activeOnly && !exerciseActive(day, ex)) continue;
    for (const s of ex.sets || []) {
      addMuscleCount(byMuscle, ex.muscle, 1, !!s.repsDone);
      addMuscleCount(byMuscle, ex.synergist, 0.5, !!s.repsDone);
    }
  }
  return Object.entries(byMuscle).sort((a, b) => b[1].total - a[1].total);
}

function clientMuscleVolume(client) {
  const byMuscle = {};
  for (const day of client.days || []) {
    for (const ex of day.exercises || []) {
      for (const s of ex.sets || []) {
        addMuscleCount(byMuscle, ex.muscle, 1, !!s.repsDone);
        addMuscleCount(byMuscle, ex.synergist, 0.5, !!s.repsDone);
      }
    }
  }
  return Object.entries(byMuscle).sort((a, b) => b[1].total - a[1].total);
}

function clientAreaHTML(client, editable) {
  if (ui.progOpen) return progressionHTML(client);
  if (ui.calendarOpen) return calendarHTML(client, editable);
  if (ui.planWeekKey) return planEditHTML(client, editable);
  if (ui.cardioOpen) return cardioHTML(client, editable);
  if (ui.feedbackOpen) return feedbackHTML(client, editable);
  if (ui.muscleOpen) return muscleVolumeHTML(client, editable);
  if (ui.pastWeekKey) return pastWeekHTML(client, editable);
  return clientAreaHTMLInner(client, editable);
}

function clientAreaHTMLInner(client, editable) {
  const day = (client.days || []).find((d) => d.id === ui.activeDayId);

  if (!day) {
    return `
      ${
        !client.__planId
          ? `<div class="toolbar-nav">
              ${editable ? `<button class="dashed-btn" id="open-calendar"><i class="ti ti-calendar-stats"></i> Calendário</button>` : ""}
              <button class="dashed-btn" id="open-cardio"><i class="ti ti-heart-rate-monitor"></i> Cardio</button>
              <button class="dashed-btn" id="open-progression"><i class="ti ti-chart-line"></i> Progressão</button>
              ${editable ? `<button class="dashed-btn" id="open-muscle"><i class="ti ti-chart-donut-3"></i> Volume muscular</button>` : ""}
              <button class="dashed-btn" id="open-feedback" style="position:relative;"><i class="ti ti-message-circle"></i> Feedbacks${hasUnreadFeedbackFor(client, editable ? "treinador" : "aluno") ? unreadDotHTML() : ""}</button>
            </div>`
          : ""
      }
      ${
        editable && !client.__planId
          ? `<button class="dashed-btn" id="toggle-more-actions" style="margin-bottom:8px;color:var(--muted);">
               <i class="ti ti-dots"></i> Mais ações
             </button>
             <div id="more-actions" class="hidden" style="display:flex; flex-direction:column; gap:8px; margin-bottom:12px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px;">
               <button class="dashed-btn" id="open-import-modal"><i class="ti ti-clipboard-text"></i> Importar treino (colar texto)</button>
               <button class="dashed-btn" id="open-img-import"><i class="ti ti-photo"></i> Importar treino (por imagem)</button>
               <button class="dashed-btn" id="open-duplicate"><i class="ti ti-copy"></i> Duplicar treinos p/ outro aluno</button>
               <div style="display:flex; gap:8px; flex-wrap:wrap;">
                 <button class="dashed-btn" id="rir-unlock-all" style="flex:1;color:var(--plate);border-color:var(--plate);"><i class="ti ti-lock-open"></i> Liberar RIR de tudo p/ ${escapeHTML(client.name.split(" ")[0])}</button>
                 <button class="dashed-btn" id="rir-lock-all" style="flex:1;"><i class="ti ti-lock"></i> Travar RIR de tudo</button>
               </div>
             </div>`
          : ""
      }
      <div class="grid ${editable ? "" : "stacked"}">
        ${(client.days || [])
          .map((d, dayIdx, dayArr) => {
            const vol = dayVolume(d, !editable);
            const lastSession = [...(client.workoutSessions || [])].filter((s) => s.dayId === d.id).sort((a, b) => b.endedAt - a.endedAt)[0];
            const sessionLine = isTimerRunning(d)
              ? `<div class="count" style="color:var(--red);display:flex;align-items:center;gap:3px;"><i class="ti ti-player-play" style="font-size:10px;"></i> em andamento</div>`
              : lastSession && lastSession.dateKey === todayKey()
              ? `<div class="count" style="color:var(--steel);display:flex;align-items:center;gap:3px;"><i class="ti ti-clock" style="font-size:10px;"></i> ${lastSession.durationMin}min hoje</div>`
              : "";
            return `
          <div class="sq" data-open="${d.id}" ${editable ? 'draggable="true"' : ""}>
            ${
              editable
                ? `<div class="sq-toolbar">
                    <button class="move-btn" data-daymove="up" data-dayid="${d.id}" ${dayIdx === 0 ? "disabled" : ""}><i class="ti ti-chevron-up"></i></button>
                    <button class="move-btn" data-daymove="down" data-dayid="${d.id}" ${dayIdx === dayArr.length - 1 ? "disabled" : ""}><i class="ti ti-chevron-down"></i></button>
                    <span style="flex:1;"></span>
                    <button class="move-btn" data-rmday="${d.id}"><i class="ti ti-trash"></i></button>
                  </div>`
                : ""
            }
            <div style="color:var(--red);">${dayIcon(d.title)}</div>
            <div>
              <div class="title display">${escapeHTML(d.title || "Sem título")}</div>
              <div class="count">${(d.exercises || []).length} exercício${(d.exercises || []).length !== 1 ? "s" : ""}</div>
              ${vol.total > 0 ? `<div class="count" style="color:${vol.done === vol.total ? "#639922" : "var(--muted)"};">${vol.done}/${vol.total} séries feitas</div>` : ""}
              ${sessionLine}
            </div>
          </div>`;
          })
          .join("")}
        ${editable ? `<div class="sq add" id="add-day-sq">+ novo treino</div>` : ""}
      </div>`;
  }

  return `
    <div class="day-head">
      <button class="back" id="back-to-grid"><i class="ti ti-chevron-left"></i> Semana</button>
      <span style="color:var(--red); flex-shrink:0; display:flex; align-items:center;">${dayIcon(day.title)}</span>
      ${
        editable
          ? `<input class="display day-title" id="day-title-input" value="${attr(day.title)}" />`
          : `<div class="display day-title">${escapeHTML(day.title)}</div>`
      }
      ${editable ? `<button class="rm-x" id="rm-day"><i class="ti ti-trash"></i></button>` : ""}
    </div>
    ${
      (() => {
        const vol = dayVolume(day, !editable);
        if (vol.total === 0) return "";
        const byMuscle = muscleVolume(day, !editable);
        const totalLine = `<div class="muted-note" style="margin:-10px 0 8px; color:${vol.done === vol.total ? "#639922" : "var(--muted)"};">${vol.done}/${vol.total} séries feitas</div>`;
        const muscleLine =
          byMuscle.length > 0
            ? `<div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px;">
                ${byMuscle
                  .map(
                    ([m, v]) =>
                      `<span class="muscle-vol-pill">${escapeHTML(m)}: <b>${fmtVol(v.done)}/${fmtVol(v.total)}</b></span>`
                  )
                  .join("")}
              </div>`
            : "";
        return totalLine + muscleLine;
      })()
    }
    ${shortModeHTML(day, editable, client)}
    ${
      !isTimerRunning(day)
        ? `<button type="button" class="cta" id="start-workout" style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:14px;">
            <i class="ti ti-player-play"></i> INICIAR TREINO
          </button>`
        : ""
    }
    <div id="exercises-wrap">
      ${(day.exercises || []).map((ex, i, arr) => exerciseHTML(ex, editable, i, arr.length, client, day)).join("")}
    </div>
    ${editable ? `<button class="dashed-btn" id="add-exercise">+ adicionar exercício</button>` : ""}
    ${
      isTimerRunning(day)
        ? `<div style="background:#2A2018;border:1px solid var(--red);border-radius:10px;padding:14px;text-align:center;margin-top:14px;">
            <div style="font-size:10px;color:#FF7A6E;letter-spacing:.05em;margin-bottom:4px;">TREINO EM ANDAMENTO</div>
            <div class="display" id="workout-timer-display" data-started="${day.timerStartedAt}" style="font-size:28px;color:var(--chalk);margin-bottom:10px;">00:00</div>
            <button type="button" style="display:flex;align-items:center;justify-content:center;gap:6px;width:100%;background:var(--red);border:none;border-radius:8px;padding:10px;color:#fff;font-size:13px;font-weight:600;" id="finish-workout">
              <i class="ti ti-player-stop"></i> FINALIZAR TREINO
            </button>
          </div>`
        : ""
    }
  `;
}

function dateTimeLabel(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const day = String(d.getDate()).padStart(2, "0");
  const months = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day}/${months[d.getMonth()]} às ${hh}:${mm}`;
}

function studentNoteHTML(ex) {
  const isOpen = !!openNotes[ex.id] || !!ex.studentNote;
  if (!isOpen) {
    return `<button type="button" class="dashed-btn" data-notetoggle="${ex.id}" style="margin-top:8px;font-size:11px;padding:5px 10px;">
              <i class="ti ti-message-circle-plus"></i> adicionar observação
            </button>`;
  }
  return `
    <button type="button" class="dashed-btn" data-notetoggle="${ex.id}" style="margin-top:8px;font-size:11px;padding:5px 10px;background:var(--redDim);border-color:var(--red);color:#FF6B5C;">
      <i class="ti ti-message-circle-x"></i> observação ativa
    </button>
    <div style="margin-top:6px;background:var(--panelAlt);border:1px solid var(--red);border-radius:8px;padding:8px 10px;">
      <input data-studentnote="${ex.id}" value="${attr(ex.studentNote || "")}" placeholder="escreva algo sobre esse exercício…" style="width:100%;background:transparent;border:none;outline:none;color:var(--chalk);font-size:12px;" />
      ${ex.studentNoteAt ? `<div style="font-size:10px;color:var(--muted);margin-top:4px;display:flex;align-items:center;gap:3px;"><i class="ti ti-clock" style="font-size:10px;"></i> escrito em ${dateTimeLabel(ex.studentNoteAt)}</div>` : ""}
    </div>`;
}

// bloco do topo do treino: o aluno escolhe entre treino completo e curto; o
// treinador só vê o resumo e se o aluno ligou o modo curto hoje. Só aparece
// quando o treinador marcou alguma prioridade, mas não todas.
function shortModeHTML(day, editable, client) {
  if (client.__planId) return "";
  const exs = day.exercises || [];
  const prio = exs.filter((e) => e.priority);
  if (!prio.length || prio.length === exs.length) return "";
  const count = (list) => list.reduce((n, e) => n + (e.sets || []).length, 0);
  const on = !!day.shortOn;
  const active = exs.filter((e) => exerciseActive(day, e));
  const summary = `${active.length} exercício${active.length !== 1 ? "s" : ""} · ${count(active)} séries`;
  if (editable) {
    return `<div class="muted-note" style="margin:-4px 0 12px;display:flex;align-items:center;gap:6px;">
        <i class="ti ti-star-filled" style="color:var(--red);font-size:12px;"></i>
        ${on ? `O aluno ligou o treino curto neste treino (${summary}).` : `Treino curto: ${prio.length} exercício${prio.length !== 1 ? "s" : ""} prioritário${prio.length !== 1 ? "s" : ""} (${count(prio)} séries).`}
      </div>`;
  }
  const btn = (mode, label, selected) =>
    `<button type="button" class="dashed-btn" data-shortmode="${mode}" aria-pressed="${selected}" style="flex:1;justify-content:center;min-height:44px;${selected ? "background:var(--redDim);border:1px solid var(--red);color:var(--chalk);font-weight:700;" : ""}">${label}</button>`;
  return `
    <div id="short-mode" style="background:var(--panel);border:1px solid ${on ? "var(--red)" : "var(--line)"};border-radius:12px;padding:12px;margin-bottom:14px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:2px;">Quanto tempo você tem hoje?</div>
      <div class="muted-note" style="margin-bottom:10px;">${summary}</div>
      <div style="display:flex;gap:8px;">
        ${btn("off", "Treino completo", !on)}
        ${btn("on", "Treino curto", on)}
      </div>
      ${on ? `<div class="muted-note" style="margin-top:8px;">O que ficou de fora continua no seu plano. Toque em Reativar se quiser fazer algum.</div>` : ""}
    </div>`;
}

// exercício que ficou de fora do treino curto: cartão enxuto, com a opção de
// trazer de volta
function leftOutExerciseHTML(ex) {
  return `
    <div class="ex-card" data-exid="${ex.id}" style="opacity:.6;">
      <div class="ex-top">
        <div class="ex-name">${escapeHTML(ex.name || "Exercício")}</div>
        <span class="muscle-tag">Fica de fora hoje</span>
      </div>
      <button type="button" class="dashed-btn" data-shortkeep="${ex.id}" data-keep="1" style="margin-top:8px;min-height:44px;"><i class="ti ti-arrow-back-up"></i> Reativar</button>
    </div>`;
}

function exerciseHTML(ex, editable, index, total, client, day) {
  if (!editable && day && !exerciseActive(day, ex)) return leftOutExerciseHTML(ex);
  const collapsed = isCollapsed(ex.id);
  return `
    <div class="ex-card" data-exid="${ex.id}">
      <div class="ex-top">
        ${
          editable
            ? `<input class="ex-name" data-field="name" enterkeyhint="done" placeholder="Exercício" value="${attr(ex.name)}" />`
            : `<div class="ex-name">${escapeHTML(ex.name || "Exercício")}</div>`
        }
        ${
          editable && !client.__planId
            ? `<button class="move-btn" data-prio="${ex.id}" aria-pressed="${!!ex.priority}" aria-label="${ex.priority ? "Prioridade no treino curto: tocar para tirar" : "Marcar como prioridade no treino curto"}" title="${ex.priority ? "Prioridade no treino curto" : "Marcar como prioridade no treino curto"}"><i class="ti ${ex.priority ? "ti-star-filled" : "ti-star"}" style="${ex.priority ? "color:var(--red);" : ""}"></i></button>`
            : ""
        }
        ${
          editable
            ? `<span class="move-btns">
                <button class="move-btn" data-move="up" data-exmove="${ex.id}" ${index === 0 ? "disabled" : ""}><i class="ti ti-chevron-up"></i></button>
                <button class="move-btn" data-move="down" data-exmove="${ex.id}" ${index === total - 1 ? "disabled" : ""}><i class="ti ti-chevron-down"></i></button>
              </span>`
            : ""
        }
        ${editable ? `<button class="rm-x" data-rmex="${ex.id}"><i class="ti ti-x"></i></button>` : ""}
        <button class="ex-toggle ${collapsed ? "collapsed" : ""}" data-toggle="${ex.id}" aria-label="Abrir/fechar exercício">▾</button>
      </div>
      ${
        !editable && day && day.shortOn && ex.shortKeep && !ex.priority
          ? `<button type="button" class="dashed-btn" data-shortkeep="${ex.id}" data-keep="0" style="min-height:44px;"><i class="ti ti-eye-off"></i> Deixar de fora de novo</button>`
          : ""
      }
      ${
        editable
          ? `<div style="display:flex; gap:6px; flex-wrap:wrap;">
              <select class="muscle-select" data-field="muscle">
                <option value="">Músculo principal…</option>
                ${MUSCLE_GROUPS.map((m) => `<option value="${m}" ${ex.muscle === m ? "selected" : ""}>${m}</option>`).join("")}
              </select>
              <select class="muscle-select" data-field="synergist" style="color:var(--muted);" title="Sinergista — conta como meia série pra esse músculo">
                <option value="">+ sinergista (½ série)</option>
                ${MUSCLE_GROUPS.map((m) => `<option value="${m}" ${ex.synergist === m ? "selected" : ""}>${m}</option>`).join("")}
              </select>
            </div>`
          : `<div style="display:flex; gap:6px; flex-wrap:wrap;">
              ${ex.muscle ? `<span class="muscle-tag">${escapeHTML(ex.muscle)}</span>` : ""}
              ${ex.synergist ? `<span class="muscle-tag" style="opacity:.6;">+½ ${escapeHTML(ex.synergist)}</span>` : ""}
            </div>`
      }
      <div class="ex-body ${collapsed ? "hidden" : ""}">
        <div class="notes-box">
          <label>ANOTAÇÕES</label>
          <textarea rows="3" data-field="notes" data-autogrow="1" placeholder="ex.: preparatória com 2 séries leves de 15 reps; trabalho com cadência 2-0-2, descanso 90s"
            ${editable ? "" : "readonly"}>${escapeHTML(ex.notes || "")}</textarea>
          ${
            ex.photoUrl || ex.hasPhoto
              ? `<div style="margin-top:8px;position:relative;">
                  <img src="${escapeHTML(ex.photoUrl || "")}" alt="Foto do exercício ${escapeHTML(ex.name || "")}" data-viewphoto="${ex.id}" data-photo-pending="${!ex.photoUrl && ex.hasPhoto ? "1" : ""}" style="width:100%;max-height:220px;object-fit:cover;border-radius:8px;display:block;cursor:zoom-in;background:#1a1a1a;" />
                  ${editable ? `<button data-rmphoto="${ex.id}" class="rm-x" style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,.6);border-radius:6px;padding:4px;"><i class="ti ti-trash"></i></button>` : ""}
                </div>`
              : editable
              ? `<label class="dashed-btn" style="margin-top:8px;display:inline-flex;cursor:pointer;">
                  <i class="ti ti-photo-plus"></i> Adicionar foto
                  <input type="file" accept="image/*" data-photoinput="${ex.id}" class="hidden" />
                </label>
                <span data-photostatus="${ex.id}" class="muted-note" style="margin-left:6px;font-size:11px;"></span>`
              : ""
          }
          ${
            ex.videoUrl
              ? `<div style="margin-top:8px;display:flex;align-items:center;gap:6px;">
                  <a href="${escapeHTML(ex.videoUrl)}" target="_blank" rel="noopener" class="dashed-btn" style="display:inline-flex;">
                    <i class="ti ti-player-play"></i> Ver vídeo
                  </a>
                  ${editable ? `<button data-rmvideo="${ex.id}" class="rm-x"><i class="ti ti-trash"></i></button>` : ""}
                </div>`
              : editable
              ? `<button class="dashed-btn" data-addvideo="${ex.id}" style="margin-top:8px;">
                  <i class="ti ti-video-plus"></i> Adicionar vídeo
                </button>`
              : ""
          }
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">SÉRIES DE TRABALHO</label>
          ${(ex.sets || []).map((s, i) => {
            // referência = o "feito" da última vez que o aluno realmente fez
            // essa série. O histórico manda, porque ele acompanha o que o aluno
            // registra depois que o plano foi criado; `prevReps`, gravado na
            // própria série quando a semana é copiada, fica de reserva.
            const ref = lastDoneRef(client, ex.name, i);
            const refReps = (ref && ref.repsDone) || s.prevReps || "";
            // a carga do último treino substitui a que veio da cópia — a não ser
            // que o treinador tenha digitado uma carga aqui dentro do plano,
            // que aí é prescrição e manda
            const refLoad = ref && ref.load && !s.loadSetByTrainer ? ref.load : "";
            return setRowHTML(ex.id, s, i, editable, refReps, (ex.sets || []).length, refLoad);
          }).join("")}
          ${editable ? `<button class="dashed-btn" data-addset="${ex.id}" style="margin-top:6px;">+ série</button>` : ""}
          ${studentNoteHTML(ex)}
        </div>
      </div>
    </div>`;
}

function setRowHTML(exId, s, i, editable, refReps = "", total = 1, refLoad = "") {
  const goal = s.repsGoal ?? s.reps ?? ""; // compatível com fichas antigas (campo único "reps")
  const rirOn = !!s.rirEnabled;
  const feitoValue = s.repsDone || "";
  // enquanto a série não foi feita NESTA semana, o número da última vez que o
  // aluno fez aparece esmaecido ao fundo, só como referência — ele não conta
  // como série feita e some no instante em que o número novo é digitado
  const ghost = !feitoValue && refReps ? refReps : "";
  const feitoPlaceholder = ghost || "0";
  return `
    <div class="set-row" data-setid="${s.id}" data-exid="${exId}">
      <span class="set-idx">${i + 1}ª</span>
      <span class="stack" style="color:var(--plate);">
        <span class="box meta grow"><input data-field="repsGoal" data-grow="1" enterkeyhint="done" value="${attr(goal)}" placeholder="meta" ${editable ? "" : "readonly"} /></span>
        <span class="unit">meta</span>
      </span>
      <span class="stack" style="color:var(--chalk);position:relative;">
        ${
          editable
            ? `<span class="box"><input class="${ghost ? "ghost-ref" : ""}" data-field="repsDone" data-grow="1" enterkeyhint="done" value="${attr(feitoValue)}" placeholder="${attr(feitoPlaceholder)}" /></span>`
            : `<button type="button" class="box feito-open${ghost ? " ghost-ref" : ""}" data-feitoopen="1">${escapeHTML(feitoValue || ghost || "–")}</button>`
        }
        <span class="unit">feito</span>
      </span>
      <span class="stack" style="color:var(--steel);">
        <span class="box kg grow"><input data-field="load" data-grow="1" enterkeyhint="done" value="${attr(refLoad || s.load)}" /></span>
        <span class="unit">kg</span>
      </span>
      ${
        editable
          ? `<span class="stack" style="color:var(--plate);">
              <span class="box rir grow"><input data-field="rir" data-grow="1" value="${attr(s.rir)}" placeholder="-" /></span>
              <span class="unit" style="display:flex;align-items:center;gap:2px;">
                rir
                <button type="button" class="rir-toggle ${rirOn ? "on" : ""}" data-rirtoggle="1" title="${rirOn ? "Aluno pode editar" : "Só você edita"}"><i class="ti ${rirOn ? "ti-lock-open" : "ti-lock"}"></i></button>
              </span>
            </span>`
          : rirOn
          ? `<span class="stack" style="color:var(--plate);">
              <span class="box rir"><input data-field="rir" value="${attr(s.rir)}" placeholder="-" /></span>
              <span class="unit">rir</span>
            </span>`
          : ""
      }
      ${
        editable
          ? `<span class="move-btns">
              <button class="move-btn" data-setmove="up" ${i === 0 ? "disabled" : ""} aria-label="Subir série"><i class="ti ti-chevron-up"></i></button>
              <button class="move-btn" data-setmove="down" ${i === total - 1 ? "disabled" : ""} aria-label="Descer série"><i class="ti ti-chevron-down"></i></button>
            </span>`
          : ""
      }
      ${editable ? `<button class="rm-x" data-rmset="1"><i class="ti ti-x"></i></button>` : ""}
    </div>`;
}

// ---------- eventos da área de treinos (funciona pra treinador e aluno) ----------

function wireClientArea(client, editable) {
  if (!client) return;

  if (editable) migrateLegacyPhotosOnce(client);

  if (ui.progOpen) {
    wireProgression(client);
    return;
  }
  if (ui.calendarOpen) {
    wireCalendar(client, editable);
    return;
  }
  if (ui.planWeekKey) {
    wirePlanEdit(client, editable);
    return;
  }
  if (ui.cardioOpen) {
    wireCardio(client, editable);
    return;
  }
  if (ui.feedbackOpen) {
    wireFeedback(client, editable);
    return;
  }
  if (ui.muscleOpen) {
    wireMuscleVolume(client, editable);
    return;
  }
  if (ui.pastWeekKey) {
    wirePastWeek(client, editable);
    return;
  }

  wireClientAreaInner(client, editable);
}

function wireClientAreaInner(client, editable) {
  if (editable && !client.__planId) {
    wireImportModal(client);
    wireDuplicateModal(client);
    wireImgImport(client);
  }
  wirePhotoViewerModal();

  const openProgBtn = document.getElementById("open-progression");
  if (openProgBtn) {
    openProgBtn.onclick = () => {
      ui.progOpen = true;
      render();
    };
  }

  const openCalBtn = document.getElementById("open-calendar");
  if (openCalBtn) {
    openCalBtn.onclick = () => {
      ui.calendarOpen = true;
      render();
    };
  }

  const openCardioBtn = document.getElementById("open-cardio");
  if (openCardioBtn) {
    openCardioBtn.onclick = () => {
      ui.cardioOpen = true;
      render();
    };
  }

  const openMuscleBtn = document.getElementById("open-muscle");
  if (openMuscleBtn) {
    openMuscleBtn.onclick = () => {
      ui.muscleOpen = true;
      render();
    };
  }

  const toggleMoreBtn = document.getElementById("toggle-more-actions");
  if (toggleMoreBtn) {
    toggleMoreBtn.onclick = () => {
      document.getElementById("more-actions").classList.toggle("hidden");
    };
  }

  const openFeedbackBtn = document.getElementById("open-feedback");
  if (openFeedbackBtn) {
    openFeedbackBtn.onclick = () => {
      markFeedbackReadFor(client, editable ? "treinador" : "aluno");
      ui.feedbackOpen = true;
      render();
    };
  }

  const setAllRir = (enabled) => (d) => ({
    ...d,
    exercises: (d.exercises || []).map((ex) => ({
      ...ex,
      sets: (ex.sets || []).map((s) => ({ ...s, rirEnabled: enabled })),
    })),
  });

  const unlockAllBtn = document.getElementById("rir-unlock-all");
  if (unlockAllBtn) {
    unlockAllBtn.onclick = () => {
      if (!confirm(`Liberar o RIR de TODAS as séries, em TODOS os treinos de ${client.name}? Ele vai poder preencher o RIR de tudo a partir de agora.`)) return;
      updateDays(client, (client.days || []).map(setAllRir(true)));
    };
  }

  const lockAllBtn = document.getElementById("rir-lock-all");
  if (lockAllBtn) {
    lockAllBtn.onclick = () => {
      if (!confirm(`Travar o RIR de todas as séries de ${client.name} de novo? Ele deixa de poder editar até você liberar.`)) return;
      updateDays(client, (client.days || []).map(setAllRir(false)));
    };
  }

  // grade
  document.querySelectorAll("[data-open]").forEach((sq) => {
    sq.onclick = (e) => {
      if (e.target.closest("[data-rmday]") || e.target.closest("[data-daymove]")) return;
      ui.activeDayId = sq.dataset.open;
      render();
    };
  });
  const addDaySq = el("add-day-sq");
  if (addDaySq) addDaySq.onclick = () => {
    const days = [...(client.days || []), emptyDay(`Treino ${String.fromCharCode(65 + (client.days || []).length)}`)];
    ui.activeDayId = days[days.length - 1].id;
    updateDays(client, days);
  };
  document.querySelectorAll("[data-rmday]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const day = (client.days || []).find((d) => d.id === btn.dataset.rmday);
      const name = day ? day.title || "este treino" : "este treino";
      if (!confirm(`Excluir "${name}"? Todos os exercícios dele serão apagados. Essa ação não pode ser desfeita.`)) return;
      updateDays(client, (client.days || []).filter((d) => d.id !== btn.dataset.rmday));
    };
  });
  document.querySelectorAll("[data-daymove]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const dayId = btn.dataset.dayid;
      const dir = btn.dataset.daymove;
      const list = [...(client.days || [])];
      const idx = list.findIndex((d) => d.id === dayId);
      const swapWith = dir === "up" ? idx - 1 : idx + 1;
      if (idx < 0 || swapWith < 0 || swapWith >= list.length) return;
      [list[idx], list[swapWith]] = [list[swapWith], list[idx]];
      updateDays(client, list);
    };
  });

  if (editable) {
    document.querySelectorAll("[data-open]").forEach((sq) => {
      sq.addEventListener("dragstart", (e) => {
        draggedDayId = sq.dataset.open;
        sq.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      sq.addEventListener("dragend", () => {
        sq.classList.remove("dragging");
        document.querySelectorAll(".sq.drag-over").forEach((el2) => el2.classList.remove("drag-over"));
      });
      sq.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (sq.dataset.open !== draggedDayId) sq.classList.add("drag-over");
      });
      sq.addEventListener("dragleave", () => sq.classList.remove("drag-over"));
      sq.addEventListener("drop", (e) => {
        e.preventDefault();
        sq.classList.remove("drag-over");
        const targetId = sq.dataset.open;
        if (!draggedDayId || draggedDayId === targetId) return;
        const list = [...(client.days || [])];
        const fromIdx = list.findIndex((d) => d.id === draggedDayId);
        const toIdx = list.findIndex((d) => d.id === targetId);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = list.splice(fromIdx, 1);
        list.splice(toIdx, 0, moved);
        draggedDayId = null;
        updateDays(client, list);
      });
    });
  }

  // detalhe do dia
  const backBtn = el("back-to-grid");
  if (backBtn) backBtn.onclick = () => { stopWorkoutClock(); ui.activeDayId = null; render(); };

  const startBtn = el("start-workout");
  if (startBtn) {
    startBtn.onclick = async () => {
      // dentro de um PLANO de semana futura, `client.days` são os dias do plano.
      // Salvar daqui sobrescreveria o treino atual do aluno com o plano inteiro.
      if (client.__planId) {
        alert("O cronômetro só funciona na semana atual — esse é um plano de uma semana futura.");
        return;
      }
      const day = (client.days || []).find((d) => d.id === ui.activeDayId);
      if (!day) return;
      if (!confirm(`Iniciar o cronômetro de "${day.title}" agora?`)) return;
      const nextDays = (client.days || []).map((d) => (d.id === day.id ? { ...d, timerStartedAt: Date.now() } : d));
      await saveClient(client.id, { days: nextDays });
    };
  }

  const finishBtn = el("finish-workout");
  if (finishBtn) {
    finishBtn.onclick = async () => {
      if (client.__planId) return; // mesmo motivo do botão de iniciar
      const day = (client.days || []).find((d) => d.id === ui.activeDayId);
      if (!day || !day.timerStartedAt) return;
      if (!confirm(`Finalizar "${day.title}" agora? Isso para o cronômetro e registra a duração.`)) return;
      const startedAt = day.timerStartedAt;
      const endedAt = Date.now();
      // trava de segurança: se o cronômetro ficou esquecido aberto, não registra
      // uma sessão de 14 horas — limita ao máximo plausível de um treino
      const durationMin = Math.min(
        Math.round(MAX_WORKOUT_MS / 60000),
        Math.max(1, Math.round((endedAt - startedAt) / 60000))
      );
      const session = { id: uid(), dayId: day.id, dayTitle: day.title, startedAt, endedAt, durationMin, dateKey: todayKey(), weekKey: weekKeyOf(todayKey()) };
      const nextDays = (client.days || []).map((d) => (d.id === day.id ? { ...d, timerStartedAt: null } : d));
      const nextSessions = [...(client.workoutSessions || []), session];
      stopWorkoutClock();
      await saveClient(client.id, { days: nextDays, workoutSessions: nextSessions });
    };
  }

  startWorkoutClock();

  const dayTitleInput = el("day-title-input");
  if (dayTitleInput) dayTitleInput.onchange = () => {
    const days = (latestClient(client).days || []).map((d) => (d.id === ui.activeDayId ? { ...d, title: dayTitleInput.value } : d));
    updateDays(client, days);
  };

  const rmDayBtn = el("rm-day");
  if (rmDayBtn) rmDayBtn.onclick = () => {
    const current = (client.days || []).find((d) => d.id === ui.activeDayId);
    const name = current ? current.title || "este treino" : "este treino";
    if (!confirm(`Excluir "${name}"? Todos os exercícios dele serão apagados. Essa ação não pode ser desfeita.`)) return;
    const days = (client.days || []).filter((d) => d.id !== ui.activeDayId);
    ui.activeDayId = null;
    updateDays(client, days);
  };

  const addExBtn = el("add-exercise");
  if (addExBtn) addExBtn.onclick = () => {
    const days = (client.days || []).map((d) =>
      d.id === ui.activeDayId ? { ...d, exercises: [...(d.exercises || []), emptyExercise()] } : d
    );
    updateDays(client, days);
  };

  // exercícios
  document.querySelectorAll("[data-rmex]").forEach((btn) => {
    btn.onclick = () => {
      const exName = btn.closest(".ex-card")?.querySelector(".ex-name")?.value
        || btn.closest(".ex-card")?.querySelector(".ex-name")?.textContent
        || "este exercício";
      if (!confirm(`Excluir "${exName}"? Essa ação não pode ser desfeita.`)) return;
      const days = (client.days || []).map((d) =>
        d.id === ui.activeDayId ? { ...d, exercises: (d.exercises || []).filter((ex) => ex.id !== btn.dataset.rmex) } : d
      );
      updateDays(client, days);
    };
  });

  // treino curto: estrela do treinador (prioridade), botões do aluno (completo /
  // curto) e Reativar. Cada gravação parte da versão mais nova da ficha.
  document.querySelectorAll("[data-prio]").forEach((btn) => {
    btn.onclick = () => {
      const exId = btn.dataset.prio;
      const days = (latestClient(client).days || []).map((d) =>
        d.id === ui.activeDayId
          ? { ...d, exercises: (d.exercises || []).map((ex) => (ex.id === exId ? { ...ex, priority: !ex.priority } : ex)) }
          : d
      );
      updateDays(client, days);
    };
  });

  document.querySelectorAll("[data-shortmode]").forEach((btn) => {
    btn.onclick = () => {
      const on = btn.dataset.shortmode === "on";
      const days = (latestClient(client).days || []).map((d) => {
        if (d.id !== ui.activeDayId) return d;
        if (on) return { ...d, shortOn: weekKeyOf(todayKey()) };
        // voltar ao completo limpa as reativações: o treino inteiro volta
        const { shortOn, ...rest } = d;
        return { ...rest, exercises: (d.exercises || []).map(({ shortKeep, ...ex }) => ex) };
      });
      updateDays(client, days);
    };
  });

  document.querySelectorAll("[data-shortkeep]").forEach((btn) => {
    btn.onclick = () => {
      const exId = btn.dataset.shortkeep;
      const keep = btn.dataset.keep === "1";
      const days = (latestClient(client).days || []).map((d) =>
        d.id === ui.activeDayId
          ? {
              ...d,
              exercises: (d.exercises || []).map((ex) => {
                if (ex.id !== exId) return ex;
                if (keep) return { ...ex, shortKeep: weekKeyOf(todayKey()) };
                const { shortKeep, ...rest } = ex;
                return rest;
              }),
            }
          : d
      );
      updateDays(client, days);
    };
  });

  document.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.onclick = () => {
      const exId = btn.dataset.toggle;
      collapsedEx[exId] = !isCollapsed(exId);
      render();
    };
  });

  document.querySelectorAll("[data-exmove]").forEach((btn) => {
    btn.onclick = () => {
      const exId = btn.dataset.exmove;
      const dir = btn.dataset.move; // "up" ou "down"
      const days = (client.days || []).map((d) => {
        if (d.id !== ui.activeDayId) return d;
        const list = [...(d.exercises || [])];
        const idx = list.findIndex((ex) => ex.id === exId);
        const swapWith = dir === "up" ? idx - 1 : idx + 1;
        if (idx < 0 || swapWith < 0 || swapWith >= list.length) return d;
        [list[idx], list[swapWith]] = [list[swapWith], list[idx]];
        return { ...d, exercises: list };
      });
      updateDays(client, days);
    };
  });

  document.querySelectorAll(".ex-card").forEach((card) => {
    const exId = card.dataset.exid;
    card.querySelectorAll("[data-field]").forEach((input) => {
      if (input.closest(".set-row")) return; // séries tratadas abaixo
      input.onchange = () => {
        const field = input.dataset.field;
        const days = (latestClient(client).days || []).map((d) => {
          if (d.id !== ui.activeDayId) return d;
          return {
            ...d,
            exercises: (d.exercises || []).map((ex) => {
              if (ex.id !== exId) return ex;
              const patch = { [field]: input.value };
              // se o nome mudou e o músculo ainda não foi escolhido, tenta adivinhar sozinho
              // (músculo principal + sinergista, quando o exercício for composto)
              if (field === "name" && !ex.muscle) {
                const guessed = guessMuscle(input.value);
                if (guessed) patch.muscle = guessed;
                if (!ex.synergist) {
                  const guessedSynergist = guessSynergist(input.value);
                  if (guessedSynergist) patch.synergist = guessedSynergist;
                }
              }
              return { ...ex, ...patch };
            }),
          };
        });
        updateDays(client, days);
      };
    });

    card.querySelectorAll("[data-autogrow]").forEach((el) => {
      growTextarea(el);
      el.oninput = () => growTextarea(el);
    });

    const photoInput = card.querySelector(`[data-photoinput="${exId}"]`);
    if (photoInput) {
      photoInput.onchange = async () => {
        const file = photoInput.files[0];
        if (!file) return;
        const statusEl = card.querySelector(`[data-photostatus="${exId}"]`);
        if (statusEl) statusEl.textContent = "comprimindo…";
        try {
          const dataUrl = await compressImageToDataUrl(file, 700, 0.6);
          if (dataUrl.length > 700000) {
            if (statusEl) statusEl.textContent = "foto muito grande/detalhada, tente outra";
            return;
          }
          // a foto vai pro documento próprio dela (subcoleção "photos"), não
          // pro documento do aluno — só a flag hasPhoto entra ali
          await savePhoto(client.id, exId, dataUrl);
          const days = (client.days || []).map((d) => {
            if (d.id !== ui.activeDayId) return d;
            return { ...d, exercises: (d.exercises || []).map((ex) => (ex.id === exId ? { ...ex, hasPhoto: true } : ex)) };
          });
          updateDays(client, days);
        } catch (e) {
          if (statusEl) statusEl.textContent = "erro ao processar a foto";
        }
      };
    }

    const viewPhotoEl = card.querySelector(`[data-viewphoto="${exId}"]`);
    if (viewPhotoEl) {
      if (viewPhotoEl.dataset.photoPending === "1") {
        loadPhoto(client.id, exId).then((dataUrl) => {
          if (dataUrl) viewPhotoEl.src = dataUrl;
        });
      }
      viewPhotoEl.onclick = async () => {
        const src = viewPhotoEl.getAttribute("src") || (await loadPhoto(client.id, exId));
        openPhotoViewer(src);
      };
    }

    const addVideoBtn = card.querySelector(`[data-addvideo="${exId}"]`);
    if (addVideoBtn) {
      addVideoBtn.onclick = () => {
        const url = prompt("Cole o link do vídeo (YouTube, Instagram, Drive, etc.):");
        if (!url || !url.trim()) return;
        const days = (client.days || []).map((d) => {
          if (d.id !== ui.activeDayId) return d;
          return { ...d, exercises: (d.exercises || []).map((ex) => (ex.id === exId ? { ...ex, videoUrl: url.trim() } : ex)) };
        });
        updateDays(client, days);
      };
    }

    const rmVideoBtn = card.querySelector(`[data-rmvideo="${exId}"]`);
    if (rmVideoBtn) {
      rmVideoBtn.onclick = () => {
        if (!confirm("Remover esse vídeo?")) return;
        const days = (client.days || []).map((d) => {
          if (d.id !== ui.activeDayId) return d;
          return { ...d, exercises: (d.exercises || []).map((ex) => (ex.id === exId ? { ...ex, videoUrl: "" } : ex)) };
        });
        updateDays(client, days);
      };
    }

    const rmPhotoBtn = card.querySelector(`[data-rmphoto="${exId}"]`);
    if (rmPhotoBtn) {
      rmPhotoBtn.onclick = async () => {
        if (!confirm("Remover essa foto?")) return;
        await deletePhoto(client.id, exId).catch(() => {});
        const days = (client.days || []).map((d) => {
          if (d.id !== ui.activeDayId) return d;
          return { ...d, exercises: (d.exercises || []).map((ex) => (ex.id === exId ? { ...ex, photoUrl: "", hasPhoto: false } : ex)) };
        });
        updateDays(client, days);
      };
    }

    const addSetBtn = card.querySelector(`[data-addset="${exId}"]`);
    if (addSetBtn) addSetBtn.onclick = () => {
      const days = (client.days || []).map((d) => {
        if (d.id !== ui.activeDayId) return d;
        return {
          ...d,
          exercises: (d.exercises || []).map((ex) => (ex.id === exId ? { ...ex, sets: [...(ex.sets || []), emptySet()] } : ex)),
        };
      });
      updateDays(client, days);
    };

    const noteToggleBtn = card.querySelector(`[data-notetoggle="${exId}"]`);
    if (noteToggleBtn) {
      noteToggleBtn.onclick = () => {
        openNotes[exId] = !openNotes[exId];
        render();
      };
    }

    const noteInput = card.querySelector(`[data-studentnote="${exId}"]`);
    if (noteInput) {
      noteInput.onchange = () => {
        const days = (latestClient(client).days || []).map((d) => {
          if (d.id !== ui.activeDayId) return d;
          return {
            ...d,
            exercises: (d.exercises || []).map((ex) => (ex.id === exId ? { ...ex, studentNote: noteInput.value, studentNoteAt: Date.now() } : ex)),
          };
        });
        updateDays(client, days);
      };
    }
  });

  // séries: reps e kg sempre editáveis (mesmo pro aluno); resto só se editable
  document.querySelectorAll(".set-row").forEach((row) => {
    const exId = row.dataset.exid;
    const setId = row.dataset.setid;

    row.querySelectorAll("[data-field]").forEach((input) => {
      input.onchange = () => {
        saveSetField(client, ui.activeDayId, exId, setId, input.dataset.field, input.value);
      };
    });

    // meta e kg crescem conforme o personal digita
    row.querySelectorAll("[data-grow]").forEach((input) => {
      growBox(input);
      input.oninput = () => growBox(input);
    });

    // "feito" abre um bloco próprio de rolagem (estilo roleta) pra escolher 1 a 15
    const feitoBtn = row.querySelector("[data-feitoopen]");
    if (feitoBtn) {
      feitoBtn.onclick = () => openFeitoPicker(client, exId, setId, feitoBtn.textContent.trim());
    }

    if (editable) {
      const rirToggleBtn = row.querySelector("[data-rirtoggle]");
      if (rirToggleBtn) {
        rirToggleBtn.onclick = () => {
          const days = (client.days || []).map((d) => {
            if (d.id !== ui.activeDayId) return d;
            return {
              ...d,
              exercises: (d.exercises || []).map((ex) => {
                if (ex.id !== exId) return ex;
                return {
                  ...ex,
                  sets: (ex.sets || []).map((s) => (s.id === setId ? { ...s, rirEnabled: !s.rirEnabled } : s)),
                };
              }),
            };
          });
          updateDays(client, days);
        };
      }

      // trocar a ordem das séries dentro do exercício
      row.querySelectorAll("[data-setmove]").forEach((btn) => {
        btn.onclick = () => {
          const dir = btn.dataset.setmove; // "up" ou "down"
          const days = (client.days || []).map((d) => {
            if (d.id !== ui.activeDayId) return d;
            return {
              ...d,
              exercises: (d.exercises || []).map((ex) => {
                if (ex.id !== exId) return ex;
                const list = [...(ex.sets || [])];
                const idx = list.findIndex((s) => s.id === setId);
                const swapWith = dir === "up" ? idx - 1 : idx + 1;
                if (idx < 0 || swapWith < 0 || swapWith >= list.length) return ex;
                [list[idx], list[swapWith]] = [list[swapWith], list[idx]];
                return { ...ex, sets: list };
              }),
            };
          });
          updateDays(client, days);
        };
      });

      const rmSetBtn = row.querySelector("[data-rmset]");
      if (rmSetBtn) rmSetBtn.onclick = () => {
        if (!confirm("Excluir essa série?")) return;
        const days = (client.days || []).map((d) => {
          if (d.id !== ui.activeDayId) return d;
          return {
            ...d,
            exercises: (d.exercises || []).map((ex) => {
              if (ex.id !== exId) return ex;
              if ((ex.sets || []).length <= 1) return ex;
              return { ...ex, sets: ex.sets.filter((s) => s.id !== setId) };
            }),
          };
        });
        updateDays(client, days);
      };
    }

    // campos que não são reps/kg ficam travados fora do modo editável
    if (!editable) {
      row.querySelectorAll("[data-field]").forEach((input) => {
        // reps e kg continuam liberados; nada a fazer aqui, já são editáveis por padrão
      });
    }
  });

  // fora das set-rows, tudo trava se não editável (nome do exercício, notas, título do dia etc. já
  // são renderizados como texto/readonly quando editable=false — ver funções acima)
}

// ---------- histórico de progressão (reps/kg por semana) ----------

// toISOString() converte pra UTC antes de cortar a data — no fuso do Brasil isso
// vira o dia seguinte a partir das 21h (ou a segunda-feira errada aos domingos
// à noite). Essas datas são sempre "dia calendário local", nunca um instante,
// então formatamos com os getters locais em vez de passar por UTC.
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayKey() {
  return localDateKey(new Date());
}

function weekKeyOf(dateKey) {
  const d = new Date(dateKey + "T00:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // volta pra segunda-feira daquela semana
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  return localDateKey(monday);
}

function addWeeks(weekKey, count) {
  const d = new Date(weekKey + "T00:00:00");
  d.setDate(d.getDate() + count * 7);
  return localDateKey(d);
}

// Referência do último treino que o aluno REALMENTE fez daquele exercício.
// Antes isso era procurado exatamente uma semana antes do plano, o que falhava
// em dois casos comuns: planejar duas ou mais semanas à frente (procurava numa
// semana que ainda nem aconteceu) e aluno que pulou uma semana. Agora vale a
// última vez que ele fez, seja quando for.
// O plano também não pode depender do instante em que foi criado: ele é uma
// cópia da semana atual tirada no momento em que o treinador abre aquela
// semana no calendário, então tudo que o aluno registrar DEPOIS disso ficava
// de fora. Por isso a referência é procurada na hora de desenhar a tela.

function lastDoneIndex(client, beforeWeekKey) {
  const hist = client.history || [];
  const key = `${client.id}|${beforeWeekKey}`;
  if (lastDoneIndexCache.key === key) return lastDoneIndexCache.map;
  const map = new Map();
  for (const h of hist) {
    if (!h.exName) continue;
    // só conta o que aconteceu ANTES da semana do plano
    if (beforeWeekKey && h.weekKey && h.weekKey >= beforeWeekKey) continue;
    if (!h.repsDone && !h.load) continue; // entrada sem nada registrado
    const k = h.exName + "|" + h.setIndex;
    const cur = map.get(k);
    if (!cur || (h.dateKey || "") >= (cur.dateKey || "")) map.set(k, h);
  }
  lastDoneIndexCache = { key, map };
  return map;
}

function lastDoneRef(client, exName, setIndex) {
  if (!client || !client.__planId || !ui.planWeekKey || !exName) return null;
  return lastDoneIndex(client, ui.planWeekKey).get(exName + "|" + setIndex) || null;
}

// aplica a mudança de um campo (reps/kg/etc.) numa série e, se for reps/kg,
// já grava uma entrada no histórico (substituindo qualquer entrada da mesma
// série feita no mesmo dia, pra não acumular lixo com múltiplas edições)
function applySetFieldChange(client, dayId, exId, setId, field, value) {
  let dayTitle = "", exName = "", setIndex = 0;
  const days = (client.days || []).map((d) => {
    if (d.id !== dayId) return d;
    dayTitle = d.title;
    return {
      ...d,
      exercises: (d.exercises || []).map((ex) => {
        if (ex.id !== exId) return ex;
        exName = ex.name;
        return {
          ...ex,
          sets: (ex.sets || []).map((s, i) => {
            if (s.id !== setId) return s;
            setIndex = i;
            return { ...s, [field]: value };
          }),
        };
      }),
    };
  });

  let history = client.history || [];
  if (field === "repsDone" || field === "load") {
    const dateKey = todayKey();
    history = history.filter((h) => !(h.setId === setId && h.dateKey === dateKey));
    const day = days.find((d) => d.id === dayId);
    const ex = day?.exercises.find((e) => e.id === exId);
    const set = ex?.sets.find((s) => s.id === setId);
    history = [
      ...history,
      {
        dateKey,
        weekKey: weekKeyOf(dateKey),
        dayId, dayTitle, exId, exName, setId, setIndex,
        repsGoal: set?.repsGoal || "",
        repsDone: set?.repsDone || "",
        load: set?.load || "",
      },
    ];
  }
  return { days, history };
}

function saveSetField(client, dayId, exId, setId, field, value) {
  client = latestClient(client); // veja `latestClient`: nunca gravar em cima de uma cópia velha
  if (client.__planId) {
    // plano futuro: só atualiza o próprio plano, sem registrar histórico
    // (nada foi "feito" de verdade ainda)
    const days = (client.days || []).map((d) => {
      if (d.id !== dayId) return d;
      return {
        ...d,
        exercises: (d.exercises || []).map((ex) => {
          if (ex.id !== exId) return ex;
          return {
            ...ex,
            sets: (ex.sets || []).map((s) => {
              if (s.id !== setId) return s;
              const next = { ...s, [field]: value };
              // carga digitada aqui dentro é prescrição do treinador: a partir
              // daí ela para de ser substituída pela do último treino. Apagar o
              // campo desfaz isso e volta a seguir o último treino do aluno.
              if (field === "load") next.loadSetByTrainer = !!value;
              return next;
            }),
          };
        }),
      };
    });
    updateDays(client, days);
    return;
  }
  const { days, history } = applySetFieldChange(client, dayId, exId, setId, field, value);
  saveClient(client.id, { days, history });
}



const WEEKDAY_RE = /\b(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)\b/i;

function stripStars(line) {
  return line.replace(/^\*+/, "").replace(/\*+$/, "").trim();
}

// extrai tipo de série / RIR / carga / observações do texto que sobrou
// depois do "Nx" e do range de reps
function extractRest(count, range, rest) {
  let load = "";
  let rir = "";

  const rirMatch = rest.match(/(\d+)\s*rir\b/i);
  if (rirMatch) rir = rirMatch[1];

  const placaMatch = rest.match(/placa\s*(\d+)/i);
  const kgMatch = rest.match(/([\d]+(?:[.,]\d+)?)\s*kg/i);

  if (placaMatch) {
    load = `Placa ${placaMatch[1]}`;
  } else if (/zerada|sem peso/i.test(rest)) {
    load = "0";
  } else if (kgMatch) {
    load = kgMatch[1];
  } else if (/peso do corpo|\bcorpo\b/i.test(rest)) {
    load = "corpo";
  }

  // o que sobrar (não virou range/kg/rir) vira observação, pra não perder informação
  // (ex.: "cluster 4x4r", "restp", "sem strap" continuam visíveis no texto)
  let leftover = rest;
  [rirMatch, placaMatch, kgMatch].forEach((m) => {
    if (m) leftover = leftover.replace(m[0], "");
  });
  leftover = leftover.replace(/zerada|sem peso|peso do corpo|\bkg\b/gi, "");
  leftover = leftover.replace(/^[\s.,;:-]+|[\s.,;:-]+$/g, "").trim();

  return { count, range, load, done: "", rir, extraNote: leftover };
}

function parseWorkLine(line) {
  // formato limpo: "NxRANGEr resto"
  const clean = line.match(/^(\d+)\s*x\s*(\d+)(?:[-\s]+(\d+))?\s*r\b(.*)$/i);
  if (clean) {
    const count = parseInt(clean[1], 10) || 1;
    const range = clean[3] ? `${clean[2]}-${clean[3]}` : clean[2];
    return extractRest(count, range, clean[4] || "");
  }

  // formato solto: "Nx resto qualquer" (placa, cluster, etc. sem range logo depois do x)
  const loose = line.match(/^(\d+)\s*x\s*(.*)$/i);
  if (loose) {
    const count = parseInt(loose[1], 10) || 1;
    const rest = loose[2] || "";
    const restForRange = rest.replace(/placa\s*\d+/i, ""); // evita o nº da placa virar "reps" por engano
    const rangeMatch = restForRange.match(/(\d+)(?:[-\s]+(\d+))?\s*r\b/i);
    const range = rangeMatch ? (rangeMatch[2] ? `${rangeMatch[1]}-${rangeMatch[2]}` : rangeMatch[1]) : "";
    return extractRest(count, range, rest);
  }

  return null;
}

function isPrepLine(line) {
  // linhas de aquecimento sem "-" na frente, tipo "12r 0kg" ou "5 8r 40kg"
  return /^\d+(?:[-\s]+\d+)?\s*r\b/i.test(line) && !/^\d+\s*x/i.test(line);
}

function looksLikeInstruction(line) {
  // linhas de instrução geral (não são nem exercício nem série), tipo "Descanso no máximo 1m30"
  return /^(descanso|obs|observa[cç][aã]o|dica)\b/i.test(line);
}

function parseWorkoutText(text) {
  const lines = text.split("\n").map((l) => l.trim());
  const days = [];
  let currentDay = null;
  let currentExercise = null;
  let started = false; // ignora linhas antes do 1º cabeçalho de dia (ex.: título da ficha)

  const ensureExercise = () => {
    if (!currentExercise) {
      currentExercise = { id: uid(), name: "Aquecimento / Mobilidade", notes: "", sets: [], _notesArr: [] };
      currentDay.exercises.push(currentExercise);
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const stripped = stripStars(line);
    if (WEEKDAY_RE.test(line)) {
      currentDay = { id: uid(), title: stripped, exercises: [] };
      days.push(currentDay);
      currentExercise = null;
      started = true;
      continue;
    }
    if (!started) continue;

    if (line.startsWith("-")) {
      ensureExercise();
      currentExercise._notesArr.push(line.slice(1).trim());
      continue;
    }

    const work = parseWorkLine(line);
    if (work) {
      ensureExercise();
      for (let n = 0; n < work.count; n++) {
        currentExercise.sets.push({
          id: uid(),
          repsGoal: work.range,
          repsDone: work.done,
          load: work.load,
          intensity: 0,
          rir: work.rir,
          rirEnabled: false,
        });
      }
      if (work.extraNote) {
        currentExercise._notesArr.push(`(série ${currentExercise.sets.length}) ${work.extraNote}`);
      }
      continue;
    }

    if (isPrepLine(line)) {
      ensureExercise();
      currentExercise._notesArr.push(line);
      continue;
    }

    if (line.startsWith("*") || (line.startsWith("(") && line.endsWith(")"))) {
      ensureExercise();
      currentExercise._notesArr.push(stripStars(line).replace(/^\(|\)$/g, ""));
      continue;
    }

    if (looksLikeInstruction(line)) {
      ensureExercise();
      currentExercise._notesArr.push(line);
      continue;
    }

    // qualquer outra linha = nome de um novo exercício
    const exName = line.replace(/:$/, "");
    currentExercise = { id: uid(), name: exName, muscle: guessMuscle(exName), synergist: guessSynergist(exName), notes: "", sets: [], _notesArr: [] };
    currentDay.exercises.push(currentExercise);
  }

  for (const day of days) {
    for (const ex of day.exercises) {
      ex.notes = ex._notesArr.join("; ");
      delete ex._notesArr;
    }
  }
  return days;
}

// ---------- importar treino por imagem (leitura de texto / OCR) ----------
// O print de outro app vira texto no próprio aparelho (nada é enviado pra fora)
// e este bloco transforma o texto em dias/exercícios. Sempre passa por uma tela
// de conferência antes de salvar, porque o OCR erra de vez em quando.

// Print de app costuma ser texto claro em fundo escuro, e o leitor lê bem melhor
// texto escuro em fundo claro. Nos testes com prints reais, inverter + tons de
// cinza SEM ampliar a imagem foi o que menos errou (ampliar piorou).
function ocrPrepareRGBA(data) {
  const px = data.length / 4;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const dark = sum / px < 128;
  for (let i = 0; i < data.length; i += 4) {
    const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const v = dark ? 255 - g : g;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return dark;
}

// o OCR costuma "comer" o traço de "6–15" e entregar "615". Procura a divisão que
// faz sentido (mínimo menor que o máximo, sem zero à esquerda, máximo até 99).
function splitGluedRange(digits) {
  for (let i = 1; i < digits.length; i++) {
    const a = digits.slice(0, i);
    const b = digits.slice(i);
    if (a[0] === "0" || b[0] === "0") continue;
    const x = parseInt(a, 10);
    const y = parseInt(b, 10);
    if (x >= 1 && y <= 99 && x < y) return [x, y];
  }
  return null;
}

const OCR_DASH = "[-\\u2013\\u2014\\u2012\\u2212~]";

// reconhece a linha de séries: "4 séries · 6–15 repetições", "3 séries" ou "3x8-12"
function parseSetsLine(line) {
  const cnt = line.match(/(\d{1,2})\s*s[eé]r[ií1l]es?\b/i);
  if (cnt) {
    const count = parseInt(cnt[1], 10);
    const rest = line.slice(cnt.index + cnt[0].length).replace(/^[\s·•.,:;|\-–—‒−]+/, "");
    let reps = "";
    const avisos = [];
    const range = rest.match(new RegExp("^(\\d{1,3})\\s*" + OCR_DASH + "+\\s*(\\d{1,3})\\b"));
    const glued = rest.match(/^(\d{3,4})\b/);
    const single = rest.match(/^(\d{1,3})\b/);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      reps = a === b ? String(a) : `${a}-${b}`;
      if (a > b) avisos.push(`repetições "${a}-${b}": o mínimo ficou maior que o máximo`);
    } else if (glued) {
      const split = splitGluedRange(glued[1]);
      if (split) {
        reps = `${split[0]}-${split[1]}`;
        avisos.push(`li "${glued[1]}" e entendi como ${reps} repetições`);
      } else {
        reps = glued[1];
        avisos.push(`repetições "${glued[1]}" parecem estranhas`);
      }
    } else if (single) {
      reps = single[1];
    }
    return { count, reps, avisos };
  }
  const x = line.match(/(\d{1,2})\s*[x×]\s*(\d{1,3})(?:\s*(?:-|–|—)\s*(\d{1,3}))?(?!\d)/i);
  if (x) {
    const reps = x[3] ? `${x[2]}-${x[3]}` : x[2];
    return { count: parseInt(x[1], 10), reps, avisos: [] };
  }
  return null;
}

const countLetters = (s) => (s.match(/\p{L}/gu) || []).length;

function cleanOcrName(s) {
  return s.replace(/^[^\p{L}\d(]+/u, "").replace(/\s+/g, " ").trim();
}

// tira o ícone de "anotação" que o OCR lê como "(3 " ou "C3 " no começo da linha
function cleanOcrNote(s) {
  return s
    .replace(/^[(\[\x7b<]\s*\S{1,2}\s+/, "")
    .replace(/^[^\p{L}\d]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

// texto de UMA imagem -> lista de exercícios (rascunho, ainda editável na conferência)
function parseImageWorkoutText(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const anchors = [];
  lines.forEach((l, i) => {
    const m = parseSetsLine(l);
    if (m) anchors.push({ i, ...m });
  });

  // o nome é a última linha com texto antes da linha de séries
  anchors.forEach((a, k) => {
    const lo = k === 0 ? -1 : anchors[k - 1].i;
    a.nameIdx = -1;
    for (let j = a.i - 1; j > lo; j--) {
      if (countLetters(lines[j]) >= 3) { a.nameIdx = j; break; }
    }
  });

  const drafts = [];
  anchors.forEach((a, k) => {
    if (a.nameIdx < 0) return;
    const next = anchors[k + 1];
    const end = next && next.nameIdx >= 0 ? next.nameIdx : next ? next.i : lines.length;
    const note = lines
      .slice(a.i + 1, end)
      .filter((l) => countLetters(l) >= 3 || /\d/.test(l))
      .map(cleanOcrNote)
      .filter((l) => countLetters(l) >= 2)
      .join("; ");
    const name = cleanOcrName(lines[a.nameIdx]);
    const avisos = [...a.avisos];
    if (a.count < 1 || a.count > 12) avisos.push(`${a.count} séries parece estranho`);
    drafts.push({
      id: uid(),
      name,
      count: a.count,
      reps: a.reps,
      note,
      muscle: guessMuscle(name),
      incluir: true,
      confere: avisos.length > 0,
      avisos,
    });
  });
  return drafts;
}

// nome sugerido pro dia, pelo grupamento que mais aparece (ex.: "Peito e tríceps")
function suggestDayTitle(drafts) {
  const family = (m) => {
    if (["Quadríceps", "Posterior de coxa", "Glúteo", "Adutores", "Panturrilha"].includes(m)) return "Pernas";
    if (m === "Deltoide posterior") return "Ombro";
    return m;
  };
  const counts = {};
  drafts.forEach((d) => {
    const f = family(d.muscle);
    if (f) counts[f] = (counts[f] || 0) + 1;
  });
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return "";
  const first = ranked[0][0];
  if (ranked[1] && ranked[1][1] >= 2) return `${first} e ${ranked[1][0].toLowerCase()}`;
  return first;
}

// rascunho já conferido -> exercício no formato que o app usa
function exerciseFromDraft(d) {
  const count = Math.max(1, Math.min(12, parseInt(d.count, 10) || 1));
  const sets = [];
  for (let n = 0; n < count; n++) {
    sets.push({ id: uid(), repsGoal: String(d.reps || "").trim(), repsDone: "", load: "", intensity: 0, rir: "", rirEnabled: false });
  }
  const name = (d.name || "").trim();
  return {
    id: uid(),
    name,
    muscle: d.muscle || guessMuscle(name),
    synergist: guessSynergist(name),
    notes: (d.note || "").trim(),
    sets,
  };
}

function openPhotoViewer(url) {
  if (!url) return;
  document.getElementById("pv-img").src = url;
  document.getElementById("photo-viewer-modal").classList.remove("hidden");
}
function closePhotoViewer() {
  document.getElementById("photo-viewer-modal").classList.add("hidden");
  document.getElementById("pv-img").src = "";
}
function wirePhotoViewerModal() {
  const backdrop = document.getElementById("pv-backdrop");
  const closeBtn = document.getElementById("pv-close");
  if (backdrop) backdrop.onclick = closePhotoViewer;
  if (closeBtn) closeBtn.onclick = closePhotoViewer;
}

function openImportModal() {
  document.getElementById("import-modal").classList.remove("hidden");
  document.getElementById("im-text").value = "";
  document.getElementById("im-error").textContent = "";
}
function closeImportModal() {
  document.getElementById("import-modal").classList.add("hidden");
}

function wireImportModal(client) {
  const openBtn = document.getElementById("open-import-modal");
  if (openBtn) openBtn.onclick = openImportModal;

  const cancelBtn = document.getElementById("im-cancel");
  const backdrop = document.getElementById("im-backdrop");
  if (cancelBtn) cancelBtn.onclick = closeImportModal;
  if (backdrop) backdrop.onclick = closeImportModal;

  const confirmBtn = document.getElementById("im-confirm");
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      const text = document.getElementById("im-text").value;
      const errorEl = document.getElementById("im-error");
      if (!text.trim()) {
        errorEl.textContent = "Cole o texto do treino antes de importar.";
        return;
      }
      const parsedDays = parseWorkoutText(text);
      if (parsedDays.length === 0) {
        errorEl.textContent = "Não encontrei nenhum dia da semana nesse texto (ex.: \"Segunda-feira\"). Confira o formato.";
        return;
      }
      const totalEx = parsedDays.reduce((sum, d) => sum + d.exercises.length, 0);
      if (!confirm(`Encontrei ${parsedDays.length} dia(s) de treino e ${totalEx} exercícios. Isso vai ADICIONAR esses treinos aos que o aluno já tem (sem apagar nada existente). Continuar?`)) {
        return;
      }
      const nextDays = [...(client.days || []), ...parsedDays];
      updateDays(client, nextDays);
      closeImportModal();
    };
  }
}

// ---------- tela de importar treino por imagem ----------

const OCR_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const OCR_LANG_URL = "https://cdn.jsdelivr.net/npm/@tesseract.js-data/por@1.0.0/4.0.0_best_int";
const IMG_IMPORT_MAX_IMAGES = 6;

let imgImport = null; // { client, step, images, days, dia, error, created, cancelled }
let imgOcrWorker = null;
let imgPasteBound = false;

function loadOcrLibrary() {
  if (window.Tesseract) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = OCR_SCRIPT_URL;
    s.onload = () => (window.Tesseract ? resolve() : reject(new Error("leitor não carregou")));
    s.onerror = () => reject(new Error("sem conexão com o leitor"));
    document.head.appendChild(s);
  });
}

// lê o arquivo, trata a imagem e devolve um canvas pronto pro leitor de texto
async function imageFileToOcrCanvas(file) {
  const bmp = await createImageBitmap(file);
  const maxW = 2400; // prints de celular têm ~1200px; só reduz imagens gigantes
  const scale = bmp.width > maxW ? maxW / bmp.width : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  if (bmp.close) bmp.close();
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  ocrPrepareRGBA(img.data);
  g.putImageData(img, 0, 0);
  return canvas;
}

function imgImportEl() { return document.getElementById("img-import-modal"); }

function openImgImport(client) {
  imgImport = { client, step: "colar", images: [], days: [], dia: 0, error: "", created: [], cancelled: false };
  imgImportEl().classList.remove("hidden");
  renderImgImport();
}

function closeImgImport() {
  if (imgImport) {
    imgImport.cancelled = true;
    imgImport.images.forEach((im) => URL.revokeObjectURL(im.url));
  }
  if (imgOcrWorker) {
    imgOcrWorker.terminate().catch(() => {});
    imgOcrWorker = null;
  }
  imgImport = null;
  imgImportEl().classList.add("hidden");
}

function imgAddFiles(files) {
  if (!imgImport || imgImport.step !== "colar") return;
  const room = IMG_IMPORT_MAX_IMAGES - imgImport.images.length;
  const imgs = Array.from(files || []).filter((f) => f && /^image\//.test(f.type)).slice(0, Math.max(0, room));
  if (imgs.length === 0) {
    imgImport.error = room <= 0 ? `Máximo de ${IMG_IMPORT_MAX_IMAGES} imagens por vez.` : "Isso não parece ser uma imagem.";
  } else {
    imgImport.error = "";
    imgs.forEach((f) => imgImport.images.push({ id: uid(), file: f, url: URL.createObjectURL(f) }));
  }
  renderImgImport();
}

function imgDraftTotals() {
  let ex = 0;
  let days = 0;
  imgImport.days.forEach((d) => {
    const n = d.exercises.filter((e) => e.incluir && e.name.trim()).length;
    if (n > 0) { ex += n; days += 1; }
  });
  return { ex, days };
}

function imgImportButtonLabel() {
  const t = imgDraftTotals();
  if (t.ex === 0) return "Importar";
  return `Importar ${t.ex} exercício${t.ex !== 1 ? "s" : ""} em ${t.days} dia${t.days !== 1 ? "s" : ""}`;
}

async function imgRead() {
  const st = imgImport;
  if (!st || st.images.length === 0) return;
  st.step = "lendo";
  st.error = "";
  st.days = [];
  st.progressLabel = "";
  renderImgImport();
  const setStatus = (txt) => {
    const el = document.getElementById("ii-status");
    if (el) el.textContent = txt;
  };
  try {
    setStatus("Carregando o leitor de texto… (na primeira vez demora um pouco)");
    await loadOcrLibrary();
    if (st.cancelled) return;
    imgOcrWorker = await window.Tesseract.createWorker("por", 1, {
      langPath: OCR_LANG_URL,
      gzip: true,
      logger: (m) => {
        if (m.status === "recognizing text" && st.progressLabel) setStatus(`${st.progressLabel} ${Math.round((m.progress || 0) * 100)}%`);
      },
    });
    for (let i = 0; i < st.images.length; i++) {
      if (st.cancelled) return;
      st.progressLabel = `Lendo imagem ${i + 1} de ${st.images.length}…`;
      setStatus(st.progressLabel);
      const canvas = await imageFileToOcrCanvas(st.images[i].file);
      const { data } = await imgOcrWorker.recognize(canvas);
      canvas.width = 0;
      const drafts = parseImageWorkoutText(data.text);
      st.days.push({ id: uid(), imagem: i + 1, title: suggestDayTitle(drafts) || `Treino ${i + 1}`, exercises: drafts });
    }
    if (st.cancelled) return;
    const first = st.days.findIndex((d) => d.exercises.length > 0);
    if (first < 0) {
      st.step = "colar";
      st.error = "Não encontrei exercícios nessas imagens. O leitor espera linhas como \"3 séries · 8–12 repetições\" (ou \"3x8-12\") logo abaixo do nome do exercício.";
    } else {
      st.step = "revisar";
      st.dia = first;
    }
  } catch (e) {
    if (st.cancelled) return;
    st.step = "colar";
    st.error = /leitor|conex|network|fetch|load/i.test(String(e && e.message))
      ? "Não consegui carregar o leitor de texto. Na primeira vez é preciso estar com internet."
      : "Não consegui ler essas imagens. Tente de novo ou use outra imagem.";
  } finally {
    if (imgOcrWorker) { imgOcrWorker.terminate().catch(() => {}); imgOcrWorker = null; }
  }
  if (imgImport === st) renderImgImport();
}

function imgDoImport() {
  const st = imgImport;
  if (!st) return;
  const newDays = [];
  st.days.forEach((d) => {
    const exs = d.exercises.filter((e) => e.incluir && e.name.trim()).map(exerciseFromDraft);
    if (exs.length > 0) newDays.push({ id: uid(), title: (d.title || "").trim() || "Treino importado", exercises: exs });
  });
  if (newDays.length === 0) {
    st.error = "Marque pelo menos um exercício para importar.";
    renderImgImport();
    return;
  }
  const latest = latestClient(st.client);
  updateDays(latest, [...(latest.days || []), ...newDays]);
  st.created = newDays.map((d) => d.id);
  st.createdInfo = newDays.map((d) => ({ title: d.title, n: d.exercises.length }));
  st.error = "";
  st.step = "pronto";
  renderImgImport();
}

function imgUndoImport() {
  const st = imgImport;
  if (!st || st.created.length === 0) return;
  const latest = latestClient(st.client);
  updateDays(latest, (latest.days || []).filter((d) => !st.created.includes(d.id)));
  st.created = [];
  st.step = "revisar";
  renderImgImport();
}

function renderImgImport() {
  const card = document.getElementById("ii-card");
  const st = imgImport;
  if (!card || !st) return;
  const err = st.error ? `<div class="ii-error" role="alert">${escapeHTML(st.error)}</div>` : "";
  const head = (title) => `<div class="im-title">${title}</div>`;

  if (st.step === "colar") {
    const thumbs = st.images
      .map(
        (im, i) => `<div class="ii-thumb">
          <img src="${im.url}" alt="Imagem ${i + 1}" />
          <button class="ii-thumb-x" data-act="rm-img" data-id="${im.id}" aria-label="Remover imagem ${i + 1}"><i class="ti ti-x"></i></button>
          <div class="ii-thumb-n">Imagem ${i + 1}</div>
        </div>`
      )
      .join("");
    card.innerHTML = `
      ${head("Importar treino por imagem")}
      <div class="ii-zone">
        <i class="ti ti-photo" style="font-size:30px;color:var(--red);"></i>
        <div style="font-weight:700;">Cole o print do treino aqui</div>
        <p class="im-hint" style="text-align:center;">No computador, use Ctrl+V. No celular, use os botões abaixo.</p>
        <button class="ii-btn" data-act="paste"><i class="ti ti-clipboard"></i> Colar da área de transferência</button>
        <button class="ii-btn ii-btn-ghost" data-act="pick"><i class="ti ti-photo-up"></i> Escolher da galeria</button>
        <input type="file" id="ii-file" accept="image/*" multiple hidden />
      </div>
      ${st.images.length ? `<div class="im-hint">${st.images.length} ${st.images.length === 1 ? "imagem colada" : "imagens coladas"}</div><div class="ii-thumbs">${thumbs}</div>` : ""}
      <p class="im-hint">Cada imagem vira um dia de treino, e você confere tudo antes de salvar. Só o texto é lido: as figuras dos exercícios não são importadas. A leitura acontece no seu aparelho; a imagem não é enviada para lugar nenhum.</p>
      ${err}
      <div class="im-actions">
        <button class="im-btn-secondary" data-act="close">Cancelar</button>
        <button class="im-btn-primary" data-act="read" ${st.images.length ? "" : "disabled"}>${st.images.length ? `Ler ${st.images.length} ${st.images.length === 1 ? "imagem" : "imagens"}` : "Ler imagens"}</button>
      </div>`;
    return;
  }

  if (st.step === "lendo") {
    card.innerHTML = `
      ${head("Lendo as imagens…")}
      <div class="ii-wait"><i class="ti ti-loader-2 ii-spin" style="font-size:28px;color:var(--red);"></i>
        <div id="ii-status" aria-live="polite">Preparando…</div>
      </div>
      <div class="im-actions"><button class="im-btn-secondary" data-act="close">Cancelar</button></div>`;
    return;
  }

  if (st.step === "revisar") {
    const tabs = st.days
      .map((d, i) => `<button class="ii-tab ${i === st.dia ? "on" : ""}" data-act="tab" data-i="${i}" role="tab" aria-selected="${i === st.dia}">Dia ${i + 1}</button>`)
      .join("");
    const d = st.days[st.dia];
    const muscleOpts = (sel) =>
      `<option value="">Sem grupamento</option>` + MUSCLE_GROUPS.map((m) => `<option value="${m}" ${sel === m ? "selected" : ""}>${m}</option>`).join("");
    const rows = d.exercises.length
      ? d.exercises
          .map(
            (e) => `<div class="ii-row ${e.incluir ? "" : "off"} ${e.confere ? "warn" : ""}" data-ex="${e.id}">
        <label class="ii-check"><input type="checkbox" data-f="incluir" ${e.incluir ? "checked" : ""} aria-label="Incluir ${attr(e.name)}" /></label>
        <div class="ii-fields">
          <input class="ii-name" data-f="name" value="${attr(e.name)}" aria-label="Nome do exercício" />
          <div class="ii-line">
            <input class="ii-num" type="number" inputmode="numeric" min="1" max="12" data-f="count" value="${attr(e.count)}" aria-label="Séries" /><span>séries</span>
            <input class="ii-reps" type="text" data-f="reps" value="${attr(e.reps)}" placeholder="reps" aria-label="Repetições (ex.: 8-12)" />
          </div>
          <select class="ii-sel" data-f="muscle" aria-label="Grupamento muscular">${muscleOpts(e.muscle)}</select>
          <textarea class="ii-note" rows="1" data-f="note" placeholder="Anotação (opcional)" aria-label="Anotação">${escapeHTML(e.note)}</textarea>
          ${e.avisos.map((a) => `<div class="ii-aviso"><i class="ti ti-alert-triangle"></i> ${escapeHTML(a)} — confira.</div>`).join("")}
        </div>
      </div>`
          )
          .join("")
      : `<div class="ii-empty">Nenhum exercício reconhecido na imagem ${d.imagem}.</div>`;
    card.innerHTML = `
      ${head("Conferir antes de importar")}
      <p class="im-hint">Confira o que foi lido. Desmarque o que não quiser e toque num campo para corrigir. Linhas com <i class="ti ti-alert-triangle" style="color:var(--plate);"></i> merecem atenção.</p>
      <div class="ii-tabs" role="tablist">${tabs}</div>
      <label class="ii-daytitle"><span>Nome do dia</span><input type="text" data-f="dayTitle" value="${attr(d.title)}" /></label>
      <div class="ii-list">${rows}</div>
      ${err}
      <div class="im-actions">
        <button class="im-btn-secondary" data-act="back">Trocar imagens</button>
        <button class="im-btn-primary" data-act="import" id="ii-import-btn">${escapeHTML(imgImportButtonLabel())}</button>
      </div>`;
    return;
  }

  if (st.step === "pronto") {
    card.innerHTML = `
      ${head("Treino importado")}
      <p class="im-hint">Os dias foram adicionados ao aluno. Cargas e "feito" começam vazios, e você ajusta qualquer exercício como de costume.</p>
      <div class="ii-done">${(st.createdInfo || []).map((d) => `<div class="ii-done-row"><span>${escapeHTML(d.title)}</span><span>${d.n} exercício${d.n !== 1 ? "s" : ""}</span></div>`).join("")}</div>
      <div class="im-actions">
        <button class="im-btn-secondary" data-act="undo">Desfazer importação</button>
        <button class="im-btn-primary" data-act="close">Pronto</button>
      </div>`;
  }
}

function wireImgImport(client) {
  const openBtn = document.getElementById("open-img-import");
  if (openBtn) openBtn.onclick = () => openImgImport(client);
  if (imgPasteBound) return;
  imgPasteBound = true;

  const modal = imgImportEl();
  modal.addEventListener("click", (ev) => {
    if (!imgImport) return;
    if (ev.target.id === "ii-backdrop") {
      if (imgImport.step === "colar" || imgImport.step === "pronto") closeImgImport();
      return;
    }
    const btn = ev.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === "close") closeImgImport();
    else if (act === "pick") document.getElementById("ii-file").click();
    else if (act === "read") imgRead();
    else if (act === "import") imgDoImport();
    else if (act === "undo") imgUndoImport();
    else if (act === "back") { imgImport.step = "colar"; imgImport.error = ""; renderImgImport(); }
    else if (act === "tab") { imgImport.dia = parseInt(btn.dataset.i, 10) || 0; imgImport.error = ""; renderImgImport(); }
    else if (act === "rm-img") {
      const im = imgImport.images.find((x) => x.id === btn.dataset.id);
      if (im) URL.revokeObjectURL(im.url);
      imgImport.images = imgImport.images.filter((x) => x.id !== btn.dataset.id);
      imgImport.error = "";
      renderImgImport();
    } else if (act === "paste") {
      if (!navigator.clipboard || !navigator.clipboard.read) {
        imgImport.error = "Este navegador não deixa colar por aqui. Use Ctrl+V ou escolha da galeria.";
        renderImgImport();
        return;
      }
      navigator.clipboard.read().then(async (items) => {
        const files = [];
        for (const it of items) {
          const type = it.types.find((t) => /^image\//.test(t));
          if (type) files.push(new File([await it.getType(type)], "colado.png", { type }));
        }
        if (files.length === 0 && imgImport) { imgImport.error = "Não há imagem copiada na área de transferência."; renderImgImport(); }
        else imgAddFiles(files);
      }).catch(() => {
        if (imgImport) { imgImport.error = "Não consegui acessar a área de transferência. Use Ctrl+V ou escolha da galeria."; renderImgImport(); }
      });
    }
  });

  // edição dos campos da conferência: atualiza o rascunho sem redesenhar (não perde o foco)
  const onField = (ev) => {
    const st = imgImport;
    const el = ev.target;
    if (!st || st.step !== "revisar" || !el.dataset || !el.dataset.f) return;
    const day = st.days[st.dia];
    if (el.dataset.f === "dayTitle") { day.title = el.value; return; }
    const row = el.closest("[data-ex]");
    const ex = row && day.exercises.find((x) => x.id === row.dataset.ex);
    if (!ex) return;
    const f = el.dataset.f;
    if (f === "incluir") {
      if (ev.type !== "change") return;
      ex.incluir = el.checked;
      row.classList.toggle("off", !ex.incluir);
    } else {
      if (ev.type === "change" && f !== "muscle") return;
      ex[f] = el.value;
    }
    const b = document.getElementById("ii-import-btn");
    if (b) b.textContent = imgImportButtonLabel();
  };
  modal.addEventListener("input", onField);
  modal.addEventListener("change", (ev) => {
    if (ev.target.id === "ii-file") {
      imgAddFiles(ev.target.files);
      return;
    }
    onField(ev);
  });

  // Ctrl+V em qualquer lugar enquanto a tela está na etapa de colar
  document.addEventListener("paste", (ev) => {
    if (!imgImport || imgImport.step !== "colar" || !ev.clipboardData) return;
    const files = Array.from(ev.clipboardData.items || []).filter((it) => it.kind === "file" && /^image\//.test(it.type)).map((it) => it.getAsFile());
    if (files.length === 0) return;
    ev.preventDefault();
    imgAddFiles(files);
  });
}

function openDuplicateModal(sourceName) {
  document.getElementById("dup-modal").classList.remove("hidden");
  document.getElementById("dup-source-name").textContent = sourceName;
  document.getElementById("dup-name").value = "";
  document.getElementById("dup-email").value = "";
  document.getElementById("dup-pass").value = "";
  document.getElementById("dup-error").textContent = "";
}
function closeDuplicateModal() {
  document.getElementById("dup-modal").classList.add("hidden");
}

function wireDuplicateModal(client) {
  const openBtn = document.getElementById("open-duplicate");
  if (openBtn) openBtn.onclick = () => openDuplicateModal(client.name);

  const cancelBtn = document.getElementById("dup-cancel");
  const backdrop = document.getElementById("dup-backdrop");
  if (cancelBtn) cancelBtn.onclick = closeDuplicateModal;
  if (backdrop) backdrop.onclick = closeDuplicateModal;

  const confirmBtn = document.getElementById("dup-confirm");
  if (confirmBtn) {
    confirmBtn.onclick = async () => {
      const name = document.getElementById("dup-name").value.trim();
      const email = document.getElementById("dup-email").value.trim();
      const pass = document.getElementById("dup-pass").value;
      const errorEl = document.getElementById("dup-error");
      errorEl.textContent = "";
      if (!name || !email || pass.length < 6) {
        errorEl.textContent = "Preencha nome, email e uma senha com 6+ caracteres.";
        return;
      }
      confirmBtn.textContent = "Criando…";
      try {
        await createStudent(name, email, pass, client.days || []);
        closeDuplicateModal();
      } catch (e) {
        errorEl.textContent = traduzErro(e.code);
      } finally {
        confirmBtn.textContent = "Criar e copiar";
      }
    };
  }
}

// ---------- bloco de rolagem (estilo roleta) pro campo "feito" ----------

const FEITO_ITEM_H = 44;

function closeFeitoPicker() {
  const el = document.getElementById("feito-picker");
  if (el) el.classList.add("hidden");
}

function openFeitoPicker(client, exId, setId, currentVal) {
  const el = document.getElementById("feito-picker");
  const nums = Array.from({ length: 16 }, (_, i) => i); // 0 a 15

  el.innerHTML = `
    <div class="fp-backdrop" id="fp-backdrop"></div>
    <div class="fp-card">
      <div class="fp-title">Quantas repetições você fez?</div>
      <div class="fp-scroll" id="fp-scroll">
        <div class="fp-pad"></div>
        ${nums
          .map((n) => `<div class="fp-item ${String(n) === String(currentVal) ? "selected" : ""}" data-num="${n}">${n}</div>`)
          .join("")}
        <div class="fp-item fp-item-more" data-more="1">…</div>
        <div class="fp-pad"></div>
      </div>
      <button type="button" class="fp-cancel" id="fp-cancel">Cancelar</button>
    </div>`;
  el.classList.remove("hidden");

  const scrollEl = document.getElementById("fp-scroll");
  const idx = Math.max(0, nums.indexOf(Number(currentVal)));
  scrollEl.scrollTop = idx * FEITO_ITEM_H;

  el.querySelectorAll("[data-num]").forEach((item) => {
    item.onclick = () => {
      const value = item.dataset.num;
      saveSetField(client, ui.activeDayId, exId, setId, "repsDone", value);
      closeFeitoPicker();
    };
  });

  const moreBtn = el.querySelector("[data-more]");
  if (moreBtn) {
    moreBtn.onclick = () => {
      const typed = prompt("Quantas repetições você fez?", currentVal || "");
      if (typed === null) return;
      const cleaned = typed.trim();
      if (!cleaned) return;
      saveSetField(client, ui.activeDayId, exId, setId, "repsDone", cleaned);
      closeFeitoPicker();
    };
  }

  document.getElementById("fp-backdrop").onclick = closeFeitoPicker;
  document.getElementById("fp-cancel").onclick = closeFeitoPicker;
}

// ---------- tela de progressão (tabela + gráfico, só treinador) ----------

function timeAgo(ms) {
  if (!ms) return "nunca entrou";
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "agora mesmo";
  if (min < 60) return `há ${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `há ${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `há ${w}sem`;
  return `há ${Math.floor(d / 30)}mês`;
}

function weekLabel(weekKey) {
  const d = new Date(weekKey + "T00:00:00");
  const day = String(d.getDate()).padStart(2, "0");
  const months = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  return `${day}/${months[d.getMonth()]}`;
}

function buildHistoryIndex(client) {
  const hist = client.history || [];
  const bySet = {};
  for (const h of hist) {
    if (!bySet[h.setId]) {
      bySet[h.setId] = { setId: h.setId, exId: h.exId, label: `${h.exName || "Exercício"} (${h.setIndex + 1}ª)`, dayTitle: h.dayTitle, entries: [] };
    }
    bySet[h.setId].entries.push(h);
  }
  return Object.values(bySet);
}

function allWeekKeys(client) {
  const set = new Set((client.history || []).map((h) => h.weekKey));
  return Array.from(set).sort();
}

function latestInWeek(entries, weekKey) {
  const inWeek = entries.filter((e) => e.weekKey === weekKey);
  if (inWeek.length === 0) return null;
  return inWeek.reduce((a, b) => (a.dateKey > b.dateKey ? a : b));
}

// ---------- aba Progressão: treino inteiro + índice de evolução por exercício ----------

const PROG_PERIODS = [
  { id: "1m", label: "1 mês", weeks: 4 },
  { id: "2m", label: "2 meses", weeks: 8 },
  { id: "3m", label: "3 meses", weeks: 13 },
  { id: "6m", label: "6 meses", weeks: 26 },
  { id: "tudo", label: "Tudo (desde o início)", weeks: 0 },
];

function progNum(v) {
  const n = parseFloat(String(v == null ? "" : v).replace(",", "."));
  return isNaN(n) ? 0 : n;
}

// Tudo que as duas telas precisam, calculado do histórico real:
//  - sets[semana]: quantas séries distintas tiveram "feito" preenchido
//  - exercises: por nome, volume da semana = soma de (carga × repetições) de cada série
//    (série sem carga conta como carga 1, ou seja, só as repetições: peso do corpo)
// Dentro da mesma semana vale o último registro de cada série.
function progWeeklyData(client, periodId, today) {
  const period = PROG_PERIODS.find((p) => p.id === periodId) || PROG_PERIODS[PROG_PERIODS.length - 1];
  const latest = new Map();
  for (const h of client.history || []) {
    if (!h.weekKey || !h.repsDone) continue;
    const k = h.weekKey + "|" + h.setId;
    const cur = latest.get(k);
    if (!cur || (h.dateKey || "") >= (cur.dateKey || "")) latest.set(k, h);
  }
  const entries = Array.from(latest.values());
  if (entries.length === 0) return { weeks: [], sets: {}, exercises: [] };

  const thisWeek = weekKeyOf(today || todayKey());
  const firstWeek = entries.reduce((m, h) => (h.weekKey < m ? h.weekKey : m), entries[0].weekKey);
  const windowStart = period.weeks ? addWeeks(thisWeek, -(period.weeks - 1)) : firstWeek;
  const start = windowStart > firstWeek ? windowStart : firstWeek;

  const sets = {};
  const volByEx = new Map();
  for (const h of entries) {
    if (h.weekKey < start) continue;
    sets[h.weekKey] = (sets[h.weekKey] || 0) + 1;
    const name = h.exName || "Exercício";
    const load = progNum(h.load);
    const vol = progNum(h.repsDone) * (load > 0 ? load : 1);
    if (!volByEx.has(name)) volByEx.set(name, {});
    const byWeek = volByEx.get(name);
    byWeek[h.weekKey] = (byWeek[h.weekKey] || 0) + vol;
  }

  const weeks = [];
  for (let w = start; w <= thisWeek; w = addWeeks(w, 1)) weeks.push(w);
  // a semana em andamento sem nenhuma série ainda não é "semana sem treino"
  if (weeks.length > 1 && !sets[thisWeek]) weeks.pop();

  const muscleOf = new Map();
  for (const d of client.days || []) for (const e of d.exercises || []) if (e.name && e.muscle) muscleOf.set(e.name, e.muscle);
  const exercises = Array.from(volByEx.entries())
    .map(([name, byWeek]) => ({ name, muscle: muscleOf.get(name) || guessMuscle(name) || "Outros", byWeek }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return { weeks, sets, exercises };
}

// Índice de evolução: a primeira semana do período em que o exercício aparece vale 0%;
// cada semana seguinte mostra quanto o volume subiu ou desceu em relação a ela.
function progIndexSeries(byWeek, weeks) {
  const pts = weeks.filter((w) => byWeek[w] > 0).map((w) => ({ week: w, vol: byWeek[w] }));
  if (pts.length === 0) return { points: [], last: 0, best: 0 };
  const base = pts[0].vol;
  const points = pts.map((p) => ({ week: p.week, value: (p.vol / base - 1) * 100 }));
  return { points, last: points[points.length - 1].value, best: Math.max(...points.map((p) => p.value)) };
}

function progLabelNum(v) {
  if (v >= 1000) return (v / 1000).toFixed(1).replace(".", ",") + "k";
  return v >= 20 ? String(Math.round(v)) : String(Math.round(v * 10) / 10).replace(".", ",");
}
function progLabelPct(v) {
  return (v > 0.5 ? "+" : "") + Math.round(v) + "%";
}
function progPct(v) {
  const r = Math.round(v);
  return (r > 0 ? "+" : "") + r + "%";
}

// gráfico de linha em SVG (sem biblioteca): eixo Y à esquerda, rótulos de semana embaixo
function progChartHTML(vals, labels, opts) {
  const { color, pct, ariaLabel } = opts;
  const W = 274, H = 160, bot = 154, top = 6;
  const mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
  const range = mx - mn || 1;
  const lo = pct ? mn - range * 0.2 : Math.max(0, mn - range * 0.2);
  const hi = mx + range * 0.2;
  const n = vals.length;
  const y = (v) => bot - ((v - lo) / (hi - lo)) * (bot - top);
  const x = (i) => (n === 1 ? W / 2 : 6 + (i / (n - 1)) * (W - 12));
  const pts = vals.map((v, i) => [x(i), y(v)]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = line + " L" + pts[n - 1][0].toFixed(1) + " " + bot + " L" + pts[0][0].toFixed(1) + " " + bot + " Z";
  const dots = n <= 14 ? pts.map((p) => "M" + p[0].toFixed(1) + " " + p[1].toFixed(1) + "h0").join(" ") : "";
  const ys = [0, 1, 2, 3].map((k) => top + (k * (bot - top)) / 3);
  const grid = ys.map((yy) => "M0 " + yy.toFixed(1) + " H" + W).join(" ");
  const yLabels = ys
    .map((yy, k) => {
      const v = hi - (k * (hi - lo)) / 3;
      return `<div style="position:absolute; right:0; top:${((yy / H) * 100).toFixed(2)}%; transform:translateY(-50%); font-size:11px; color:var(--muted);">${pct ? progLabelPct(v) : progLabelNum(v)}</div>`;
    })
    .join("");
  const idxs = n <= 5 ? vals.map((_, i) => i) : [0, 1, 2, 3, 4].map((k) => Math.round((k * (n - 1)) / 4));
  const xLabels = idxs.map((i) => `<div>${escapeHTML(labels[i])}</div>`).join("");
  return `
    <div style="display:flex; gap:6px; align-items:stretch;">
      <div style="position:relative; width:36px; flex-shrink:0;">${yLabels}</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${attr(ariaLabel)}" style="display:block; flex:1; min-width:0; aspect-ratio:${W}/${H};">
        <path d="${grid}" stroke="#3A3742" stroke-width="1" fill="none"/>
        <path d="${area}" fill="${color}" fill-opacity="0.12" stroke="none"/>
        <path d="${line}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots ? `<path d="${dots}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"/>` : ""}
      </svg>
    </div>
    <div style="display:flex; justify-content:space-between; margin-left:42px; font-size:11px; color:var(--muted);">${xLabels}</div>`;
}

function progMenuHTML(id, label, current, options, extraKey) {
  // botão + lista suspensa. options: [{id,label,qtd?}]
  const open = ui.progMenu === id;
  return `
    <div style="position:relative;">
      <button id="prog-${id}-btn" aria-haspopup="listbox" aria-expanded="${open}" style="display:flex; align-items:center; gap:8px; width:100%; min-height:48px; padding:0 14px; border-radius:12px; border:1px solid ${open ? "var(--red)" : "var(--line)"}; background:var(--bg); color:var(--chalk); font-size:15px; text-align:left; box-sizing:border-box;">
        ${label ? `<span style="color:var(--muted); font-size:13px;">${label}</span>` : ""}
        <span style="flex-grow:1; font-weight:700;">${escapeHTML(current)}</span>
        <i class="ti ti-chevron-down"></i>
      </button>
      ${
        open
          ? `<div id="prog-menu-backdrop" style="position:fixed; inset:0; z-index:9;"></div>
        <div role="listbox" aria-label="${attr(extraKey)}" style="position:absolute; z-index:10; left:0; right:0; top:54px; max-height:288px; overflow-y:auto; border:1px solid var(--red); border-radius:12px; background:var(--panelAlt); box-shadow:0 10px 24px rgba(0,0,0,0.5);">
          ${options
            .map(
              (o) => `<button role="option" aria-selected="${o.on}" data-prog-pick="${id}" data-value="${attr(o.id)}" style="display:flex; align-items:center; width:100%; min-height:48px; padding:0 14px; border:none; border-top:1px solid var(--line); background:${o.on ? "rgba(255,68,51,0.14)" : "transparent"}; color:var(--chalk); font-size:15px; font-weight:${o.on ? 700 : 400}; text-align:left;">
                <span style="flex-grow:1;">${escapeHTML(o.label)}</span>
                ${o.qtd ? `<span style="font-size:12px; color:var(--muted); margin-right:10px;">${escapeHTML(o.qtd)}</span>` : ""}
                <span style="color:var(--red); font-weight:700; width:14px;">${o.on ? "✓" : ""}</span>
              </button>`
            )
            .join("")}
        </div>`
          : ""
      }
    </div>`;
}

function progNormalize(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// exercícios que aparecem na lista (grupamento escolhido + texto da busca), por grupamento e em ordem alfabética
function progListSections(exercises, group, query) {
  const q = progNormalize(query.trim());
  const sections = [];
  for (const e of exercises) {
    if (group !== "todos" && e.muscle !== group) continue;
    if (q && progNormalize(e.name).indexOf(q) < 0) continue;
    let s = sections.find((x) => x.nome === e.muscle);
    if (!s) { s = { nome: e.muscle, itens: [] }; sections.push(s); }
    s.itens.push(e);
  }
  sections.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  return sections;
}

function progListInnerHTML(exercises, group, query) {
  const sections = progListSections(exercises, group, query);
  if (sections.length === 0) return `<div style="padding:16px 14px; font-size:14px; color:var(--muted);">Nenhum exercício encontrado${group !== "todos" ? " nesse grupamento" : ""}.</div>`;
  return sections
    .map(
      (s) => `<div>
        <div style="padding:8px 14px 4px 14px; font-size:12px; font-weight:700; color:var(--red);">${escapeHTML(s.nome)}</div>
        ${s.itens
          .map(
            (e) => `<button data-prog-ex="${attr(e.name)}" style="display:flex; align-items:center; gap:10px; width:100%; min-height:48px; padding:0 14px; border:none; border-top:1px solid var(--panelAlt); background:transparent; color:var(--chalk); font-size:15px; text-align:left;">
              <span style="flex-grow:1;">${escapeHTML(e.name)}</span><i class="ti ti-chevron-right" style="color:var(--muted);"></i>
            </button>`
          )
          .join("")}
      </div>`
    )
    .join("");
}

function progExerciseCardHTML(data, name) {
  const ex = data.exercises.find((e) => e.name === name);
  const title = `<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
      <div style="font-size:17px; font-weight:700;">${escapeHTML(name)}</div>
      ${ex ? `<div style="font-size:11px; font-weight:600; padding:3px 8px; border-radius:10px; border:1px solid var(--line); color:var(--muted);">${escapeHTML(ex.muscle)}</div>` : ""}
    </div>`;
  const wrap = (inner) => `<div style="border:1px solid #2EE6D6; box-shadow:0 0 12px rgba(46,230,214,0.28); border-radius:16px; background:var(--panel); padding:16px; display:flex; flex-direction:column; gap:14px;">${inner}</div>`;
  if (!ex) return wrap(`${title}<div style="font-size:13px; color:var(--muted);">Sem registros desse exercício neste período.</div>`);
  const idx = progIndexSeries(ex.byWeek, data.weeks);
  if (idx.points.length < 2) {
    return wrap(`${title}<div style="font-size:13px; color:var(--muted);">Para mostrar a evolução, preciso de pelo menos 2 semanas com esse exercício no período. Por enquanto há ${idx.points.length}.</div>`);
  }
  return wrap(`
    <div style="display:flex; flex-direction:column; gap:4px;">
      ${title}
      <div style="font-size:13px; color:var(--muted);">Evolução no período: ${progPct(idx.last)} · melhor semana: ${progPct(idx.best)}</div>
    </div>
    ${progChartHTML(idx.points.map((p) => p.value), idx.points.map((p) => weekLabel(p.week)), { color: "#2EE6D6", pct: true, ariaLabel: `Gráfico do índice de evolução de ${name}, em porcentagem` })}
    <div style="font-size:12px; line-height:1.4; color:var(--muted);">Índice de evolução: a primeira semana do período vale 0%, e cada semana mostra quanto subiu ou desceu em relação a ela. Considera o volume (carga × repetições de todas as séries), então sobe com mais carga, mais repetições ou as duas.</div>`);
}

function progressionHTML(client) {
  const rows = buildHistoryIndex(client);
  const weeks = allWeekKeys(client).slice(-8);
  const tab = (id, label) => `<button class="dashed-btn" id="prog-tab-${id}" style="${ui.progMode === id ? "border-style:solid;color:var(--chalk);" : ""}">${label}</button>`;
  return `
    <div class="day-head">
      <button class="back" id="prog-back"><i class="ti ti-chevron-left"></i> Aluno</button>
      <div class="display day-title">Progressão</div>
    </div>
    <div style="display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap;">
      ${tab("evolucao", "Evolução")}
      ${tab("table", "Tabela")}
    </div>
    ${
      rows.length === 0
        ? `<p class="muted-note">Ainda não há histórico. Assim que reps ou kg forem alterados pelo aluno (ou por você), a progressão aparece aqui, semana a semana.</p>`
        : ui.progMode === "table"
        ? progTableHTML(rows, weeks)
        : progEvolucaoHTML(client)
    }`;
}

function progEvolucaoHTML(client) {
  const data = progWeeklyData(client, ui.progPeriod);
  const period = PROG_PERIODS.find((p) => p.id === ui.progPeriod) || PROG_PERIODS[PROG_PERIODS.length - 1];
  const total = data.weeks.reduce((a, w) => a + (data.sets[w] || 0), 0);
  const trained = data.weeks.filter((w) => data.sets[w] > 0).length;
  const setsPerWeek = data.weeks.map((w) => data.sets[w] || 0);

  const card = (inner) => `<div style="border:1px solid var(--red); box-shadow:0 0 14px rgba(255,68,51,0.35); border-radius:16px; background:var(--panel); padding:16px; display:flex; flex-direction:column; gap:14px; margin-bottom:16px;">${inner}</div>`;
  const stat = (label, v) => `<div style="flex:1; background:var(--panelAlt); border-radius:12px; padding:10px 12px;"><div style="font-size:11px; color:var(--muted);">${label}</div><div style="font-size:22px; font-weight:700;">${v}</div></div>`;

  const groups = Array.from(new Set(data.exercises.map((e) => e.muscle))).sort((a, b) => a.localeCompare(b, "pt-BR"));
  if (ui.progGroup !== "todos" && !groups.includes(ui.progGroup)) ui.progGroup = "todos";
  const groupOpts = [{ id: "todos", label: "Todos os grupamentos", qtd: `${data.exercises.length} exerc.`, on: ui.progGroup === "todos" }].concat(
    groups.map((g) => ({ id: g, label: g, qtd: `${data.exercises.filter((e) => e.muscle === g).length} exerc.`, on: ui.progGroup === g }))
  );
  const periodOpts = PROG_PERIODS.map((p) => ({ id: p.id, label: p.label, on: p.id === period.id }));

  if (!ui.progSel || !data.exercises.some((e) => e.name === ui.progSel)) {
    const first = progListSections(data.exercises, ui.progGroup, "")[0];
    ui.progSel = first ? first.itens[0].name : ui.progSel;
  }

  return `
    ${card(`
      <div style="display:flex; flex-direction:column; gap:3px;">
        <div style="font-size:17px; font-weight:700;">Evolução do treino inteiro</div>
        <div style="font-size:12px; line-height:1.4; color:var(--muted);">Séries feitas por semana, somando todos os exercícios.</div>
      </div>
      ${progMenuHTML("periodo", "Período", period.label, periodOpts, "Escolher período")}
      <div style="display:flex; gap:10px;">${stat("Séries no período", total)}${stat("Semanas treinadas", trained)}</div>
      ${
        data.weeks.length >= 2
          ? progChartHTML(setsPerWeek, data.weeks.map(weekLabel), { color: "#FF4433", pct: false, ariaLabel: "Gráfico de séries por semana no período escolhido" })
          : `<div style="font-size:13px; color:var(--muted);">Para desenhar o gráfico, preciso de pelo menos 2 semanas de treino no período.</div>`
      }`)}
    <div style="display:flex; flex-direction:column; gap:4px; margin-bottom:12px;">
      <h2 style="margin:0; font-size:20px; font-weight:700;">Progressão por exercício</h2>
      <div style="font-size:12px; line-height:1.4; color:var(--muted);">Escolha o grupamento muscular, depois o exercício. Usa o mesmo período do gráfico acima.</div>
    </div>
    <div style="display:flex; flex-direction:column; gap:10px;">
      <div style="font-size:12px; color:var(--muted);">Grupamento muscular</div>
      ${progMenuHTML("grupo", "", ui.progGroup === "todos" ? "Todos os grupamentos" : ui.progGroup, groupOpts, "Escolher grupamento muscular")}
      <label for="prog-q" style="font-size:12px; color:var(--muted);">Buscar exercício</label>
      <div style="display:flex; align-items:center; gap:10px; min-height:48px; padding:0 14px; border-radius:14px; border:1px solid ${ui.progListOpen ? "var(--red)" : "var(--line)"}; background:var(--panel);">
        <i class="ti ti-search" style="color:var(--muted);"></i>
        <input id="prog-q" type="text" value="${attr(ui.progQ)}" placeholder="Digite o nome do exercício" autocomplete="off" style="flex:1; min-width:0; height:46px; background:transparent; border:none; outline:none; color:var(--chalk); font-size:15px;">
      </div>
      <div id="prog-list-wrap" style="${ui.progListOpen ? "" : "display:none;"}">
        <div id="prog-list" style="border:1px solid var(--line); border-radius:14px; background:var(--panel); max-height:330px; overflow-y:auto;">${progListInnerHTML(data.exercises, ui.progGroup, ui.progQ)}</div>
        <button id="prog-list-close" style="min-height:44px; padding:0 4px; background:transparent; border:none; color:var(--red); font-size:14px; font-weight:600; text-decoration:underline;">Fechar lista</button>
      </div>
      <div id="prog-ex-card" style="${ui.progListOpen ? "display:none;" : ""}">${ui.progSel ? progExerciseCardHTML(data, ui.progSel) : ""}</div>
    </div>`;
}

function progTableHTML(rows, weeks) {
  return `
    <div style="overflow-x:auto;">
      <table style="border-collapse:collapse; width:100%; font-size:12px;">
        <thead>
          <tr>
            <th style="text-align:left; padding:6px 10px; color:var(--muted); font-weight:600; white-space:nowrap; position:sticky; left:0; background:var(--panel);">Série</th>
            ${weeks.map((w) => `<th style="padding:6px 10px; color:var(--muted); font-weight:600; white-space:nowrap;">${weekLabel(w)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((r) => {
              let prevVal = null;
              const cells = weeks
                .map((w) => {
                  const e = latestInWeek(r.entries, w);
                  if (!e) return `<td style="padding:6px 10px; text-align:center; color:var(--line);">—</td>`;
                  const raw = e.load || e.repsDone || "";
                  const num = parseFloat(String(raw).replace(",", "."));
                  let arrow = "";
                  if (prevVal != null && !isNaN(num)) {
                    if (num > prevVal) arrow = ` <span style="color:#639922;"><i class="ti ti-arrow-up"></i></span>`;
                    else if (num < prevVal) arrow = ` <span style="color:#E24B4A;"><i class="ti ti-arrow-down"></i></span>`;
                  }
                  if (!isNaN(num)) prevVal = num;
                  const label = `${e.repsDone || e.repsGoal || "-"}r${e.load ? " · " + e.load + "kg" : ""}`;
                  return `<td style="padding:6px 10px; text-align:center; white-space:nowrap; color:var(--chalk);">${label}${arrow}</td>`;
                })
                .join("");
              return `<tr style="border-top:1px solid var(--line);">
                <td style="padding:6px 10px; white-space:nowrap; position:sticky; left:0; background:var(--bg); color:var(--chalk);">${escapeHTML(r.label)}</td>
                ${cells}
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function wireProgression(client) {
  const backBtn = document.getElementById("prog-back");
  if (backBtn) backBtn.onclick = () => { ui.progOpen = false; ui.progMenu = null; ui.progListOpen = false; render(); };

  const tabEvo = document.getElementById("prog-tab-evolucao");
  const tabTable = document.getElementById("prog-tab-table");
  if (tabEvo) tabEvo.onclick = () => { ui.progMode = "evolucao"; ui.progMenu = null; render(); };
  if (tabTable) tabTable.onclick = () => { ui.progMode = "table"; ui.progMenu = null; render(); };

  if (ui.progMode === "table") return;

  for (const id of ["periodo", "grupo"]) {
    const btn = document.getElementById(`prog-${id}-btn`);
    if (btn) btn.onclick = () => { ui.progMenu = ui.progMenu === id ? null : id; render(); };
  }
  const backdrop = document.getElementById("prog-menu-backdrop");
  if (backdrop) backdrop.onclick = () => { ui.progMenu = null; render(); };
  document.querySelectorAll("[data-prog-pick]").forEach((b) => {
    b.onclick = () => {
      if (b.dataset.progPick === "periodo") ui.progPeriod = b.dataset.value;
      else { ui.progGroup = b.dataset.value; ui.progListOpen = true; }
      ui.progMenu = null;
      render();
    };
  });

  const wrap = document.getElementById("prog-list-wrap");
  const exCard = document.getElementById("prog-ex-card");
  const list = document.getElementById("prog-list");
  const q = document.getElementById("prog-q");
  const showList = (open) => {
    ui.progListOpen = open;
    if (wrap) wrap.style.display = open ? "" : "none";
    if (exCard) exCard.style.display = open ? "none" : "";
  };
  if (q) {
    q.onfocus = () => showList(true);
    q.oninput = () => {
      ui.progQ = q.value;
      showList(true);
      if (list) list.innerHTML = progListInnerHTML(progWeeklyData(client, ui.progPeriod).exercises, ui.progGroup, ui.progQ);
    };
  }
  if (list) {
    list.onclick = (e) => {
      const b = e.target.closest("[data-prog-ex]");
      if (!b) return;
      ui.progSel = b.dataset.progEx;
      ui.progListOpen = false;
      ui.progQ = "";
      render();
    };
  }
  const closeBtn = document.getElementById("prog-list-close");
  if (closeBtn) closeBtn.onclick = () => { ui.progQ = ""; if (q) q.value = ""; if (list) list.innerHTML = progListInnerHTML(progWeeklyData(client, ui.progPeriod).exercises, ui.progGroup, ""); showList(false); };
}

// ---------- calendário de semanas ----------

function weekRangeLabel(weekKey) {
  const start = new Date(weekKey + "T00:00:00");
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return `${weekLabel(weekKey)} – ${weekLabel(localDateKey(end))}`;
}

// resumo (só leitura) do que foi feito numa semana já passada, a partir do histórico
function pastWeekSummary(client, weekKey) {
  const entries = (client.history || []).filter((h) => h.weekKey === weekKey);
  const byEx = {};
  for (const h of entries) {
    if (!byEx[h.exId]) byEx[h.exId] = { name: h.exName, sets: [] };
    byEx[h.exId].sets.push(h);
  }
  return Object.values(byEx);
}

// agrupa o histórico de uma semana por DIA de treino (Treino A, B...) e,
// dentro de cada dia, por exercício — pra reconstruir uma visão de leitura
// de como ficou aquela semana
function pastWeekByDay(client, weekKey) {
  const entries = (client.history || []).filter((h) => h.weekKey === weekKey);
  const byDay = {};
  for (const h of entries) {
    const dayKey = h.dayId || h.dayTitle || "sem-dia";
    if (!byDay[dayKey]) byDay[dayKey] = { title: h.dayTitle || "Treino", byEx: {} };
    if (!byDay[dayKey].byEx[h.exId]) byDay[dayKey].byEx[h.exId] = { name: h.exName, sets: [] };
    byDay[dayKey].byEx[h.exId].sets.push(h);
  }
  return Object.values(byDay).map((d) => ({
    title: d.title,
    exercises: Object.values(d.byEx).map((ex) => ({ ...ex, sets: ex.sets.sort((a, b) => a.setIndex - b.setIndex) })),
  }));
}

function calendarHTML(client, editable) {
  const activeKey = client.activeWeekKey || weekKeyOf(todayKey());
  const plans = client.weekPlans || [];
  const offsets = [-2, -1, 0, 1, 2, 3];
  const realCurrentKey = weekKeyOf(todayKey());
  const dateIsWrong = editable && activeKey !== realCurrentKey;

  return `
    <div class="day-head">
      <button class="back" id="cal-back"><i class="ti ti-chevron-left"></i> Aluno</button>
      <div class="display day-title">Calendário</div>
    </div>
    ${
      dateIsWrong
        ? `<div style="background:var(--redDim); border:1px solid var(--red); border-radius:10px; padding:10px 12px; margin-bottom:12px; font-size:12px; color:var(--chalk);">
            A "semana atual" marcada aqui (${weekRangeLabel(activeKey)}) não bate com a data de hoje.
            <button id="fix-week-date" style="display:block; margin-top:6px; color:var(--plate); text-decoration:underline;">Corrigir pra semana de hoje (${weekRangeLabel(realCurrentKey)})</button>
          </div>`
        : ""
    }
    <div style="display:flex; flex-direction:column; gap:8px;">
      ${offsets
        .map((off) => {
          const wk = addWeeks(activeKey, off);
          const isPast = off < 0;
          const isCurrent = off === 0;
          const plan = plans.find((p) => p.weekKey === wk);
          const vol = isCurrent ? dayVolume({ exercises: (client.days || []).flatMap((d) => d.exercises || []) }) : null;

          let statusHTML = "";
          let icon = "ti-calendar";
          let iconColor = "var(--steel)";
          let cardStyle = "background:var(--panel);border:1px solid var(--line);";

          if (isPast) {
            icon = "ti-check";
            iconColor = "#639922";
            cardStyle += "opacity:.65;";
            const summary = pastWeekSummary(client, wk);
            statusHTML = summary.length ? `Concluída · ${summary.reduce((a, e) => a + e.sets.length, 0)} séries registradas` : "Sem registros";
          } else if (isCurrent) {
            icon = "ti-flame";
            iconColor = "var(--red)";
            cardStyle = "background:#2A2018;border:1px solid var(--red);";
            statusHTML = `Semana atual · ${vol.done}/${vol.total} séries`;
          } else if (plan) {
            icon = "ti-calendar-event";
            iconColor = "var(--plate)";
            statusHTML = "Planejada";
          } else {
            statusHTML = editable ? "Ainda não planejada" : "Ainda não disponível";
          }

          return `
          <div class="cal-row" data-calweek="${wk}" data-caloff="${off}" style="${cardStyle} border-radius:10px; padding:10px 12px; display:flex; align-items:center; gap:10px; cursor:pointer;">
            <i class="ti ${icon}" style="color:${iconColor}; font-size:18px;"></i>
            <div style="flex:1;">
              <div style="color:var(--chalk); font-size:13px; ${isCurrent ? "font-weight:600;" : ""}">${weekRangeLabel(wk)}</div>
              <div style="color:var(--muted); font-size:11px;">${statusHTML}</div>
            </div>
            ${editable && !isPast && !isCurrent ? `<i class="ti ${plan ? "ti-edit" : "ti-plus"}" style="color:var(--plate); font-size:15px;"></i>` : ""}
            ${!editable && !isPast && !isCurrent && !plan ? "" : `<i class="ti ti-chevron-right" style="color:var(--muted); font-size:15px;"></i>`}
          </div>`;
        })
        .join("")}
    </div>`;
}

function wireCalendar(client, editable) {
  const backBtn = el("cal-back");
  if (backBtn) backBtn.onclick = () => { ui.calendarOpen = false; render(); };

  const fixBtn = el("fix-week-date");
  if (fixBtn) {
    fixBtn.onclick = async () => {
      await saveClient(client.id, { activeWeekKey: weekKeyOf(todayKey()) });
    };
  }

  document.querySelectorAll("[data-calweek]").forEach((row) => {
    row.onclick = async () => {
      const wk = row.dataset.calweek;
      const off = parseInt(row.dataset.caloff, 10);
      const activeKey = client.activeWeekKey || weekKeyOf(todayKey());

      if (off < 0) {
        ui.calendarOpen = false;
        ui.pastWeekKey = wk;
        render();
        return;
      }
      if (off === 0) {
        ui.calendarOpen = false; // semana atual: volta pra grade normal de treinos
        render();
        return;
      }

      // semana futura
      const plans = client.weekPlans || [];
      let plan = plans.find((p) => p.weekKey === wk);
      if (!plan && editable) {
        // as fotos dos exercícios precisam ser copiadas pros ids novos, senão
        // elas somem da semana seguinte
        const photoPairs = [];
        // semana nova: zera o "feito" e leva o número da última vez como referência
        let planDays = cloneDaysWithNewIds(client.days || [], true, photoPairs, true);
        planDays = await clonePhotosForNewIds(client.id, planDays, photoPairs);
        plan = { id: uid(), weekKey: wk, days: planDays };
        const nextPlans = [...plans, plan];
        await saveClient(client.id, { weekPlans: nextPlans, activeWeekKey: activeKey });
      }
      if (!plan) return; // aluno tentando abrir semana ainda sem plano
      ui.calendarOpen = false;
      ui.planWeekKey = wk;
      render();
    };
  });
}

// ---------- cardio ----------

const CARDIO_ZONES = [
  { key: "Z1", label: "Z1 · muito leve", color: "var(--muted)" },
  { key: "Z2", label: "Z2 · leve", color: "var(--steel)" },
  { key: "Z3", label: "Z3 · moderada", color: "var(--plate)" },
  { key: "Z4", label: "Z4 · intensa", color: "#E8875A" },
  { key: "Z5", label: "Z5 · máxima", color: "var(--red)" },
];
function zoneInfo(key) {
  return CARDIO_ZONES.find((z) => z.key === key) || { key, label: key || "-", color: "var(--muted)" };
}

function cardioTotals(client, sinceDateKey) {
  const entries = (client.cardio || []).filter((e) => e.dateKey >= sinceDateKey);
  const totalMin = entries.reduce((sum, e) => sum + (Number(e.minutes) || 0), 0);
  const byZone = {};
  for (const e of entries) {
    if (!e.zone) continue;
    byZone[e.zone] = (byZone[e.zone] || 0) + (Number(e.minutes) || 0);
  }
  return { totalMin, byZone, count: entries.length };
}

function monthStartKey(dateKey) {
  return dateKey.slice(0, 7) + "-01";
}

function cardioHTML(client, editable) {
  const weekTotals = cardioTotals(client, weekKeyOf(todayKey()));
  const monthTotals = cardioTotals(client, monthStartKey(todayKey()));
  const entries = [...(client.cardio || [])].sort((a, b) => b.dateKey.localeCompare(a.dateKey));

  const zoneBreakdown = (totals) =>
    Object.keys(totals.byZone).length === 0
      ? ""
      : `<div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;">
          ${Object.entries(totals.byZone)
            .map(([z, min]) => {
              const zi = zoneInfo(z);
              return `<span style="font-size:11px; color:${zi.color}; border:1px solid var(--line); border-radius:20px; padding:2px 8px;">${zi.key} · ${min}min</span>`;
            })
            .join("")}
        </div>`;

  return `
    <div class="day-head">
      <button class="back" id="cardio-back"><i class="ti ti-chevron-left"></i> Aluno</button>
      <div class="display day-title" style="font-size:18px;">Cardio</div>
    </div>

    <div style="display:flex; gap:10px; margin-bottom:16px;">
      <div style="flex:1; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px;">
        <div class="muted-note" style="font-size:11px; text-transform:uppercase; letter-spacing:.05em;">Essa semana</div>
        <div class="display" style="font-size:24px; margin-top:2px;">${weekTotals.totalMin} min</div>
        ${zoneBreakdown(weekTotals)}
      </div>
      <div style="flex:1; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px;">
        <div class="muted-note" style="font-size:11px; text-transform:uppercase; letter-spacing:.05em;">Esse mês</div>
        <div class="display" style="font-size:24px; margin-top:2px;">${monthTotals.totalMin} min</div>
        ${zoneBreakdown(monthTotals)}
      </div>
    </div>

    <button class="cta" id="cardio-add" style="margin-bottom:16px;"><i class="ti ti-plus"></i> Registrar cardio</button>
    <div id="cardio-form" class="hidden" style="display:flex; flex-direction:column; gap:8px; background:var(--panelAlt); border:1px solid var(--line); border-radius:10px; padding:12px; margin-bottom:16px;">
      <div style="display:flex; gap:8px; align-items:center;">
        <input id="cardio-minutes" type="number" min="1" placeholder="minutos" style="width:90px; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px; color:var(--chalk); text-align:center;" />
        <select id="cardio-zone" style="flex:1; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px; color:var(--chalk);">
          <option value="">Zona (opcional)</option>
          ${CARDIO_ZONES.map((z) => `<option value="${z.key}">${z.label}</option>`).join("")}
        </select>
      </div>
      <textarea id="cardio-note" rows="2" placeholder="observações (opcional)" style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px; color:var(--chalk); resize:none;"></textarea>
      <div id="cardio-error" class="error" style="font-size:12px;"></div>
      <div style="display:flex; justify-content:flex-end; gap:8px;">
        <button id="cardio-cancel" style="color:var(--muted); font-size:13px;">cancelar</button>
        <button id="cardio-save" style="color:var(--plate); font-size:13px;">salvar</button>
      </div>
    </div>

    <div class="muted-note" style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; margin-bottom:8px;">Histórico</div>
    ${
      entries.length === 0
        ? `<p class="muted-note">Nenhum cardio registrado ainda.</p>`
        : entries
            .map((e) => {
              const zi = e.zone ? zoneInfo(e.zone) : null;
              return `
              <div style="display:flex; align-items:center; gap:10px; padding:8px 0; border-top:1px solid var(--line);">
                <i class="ti ti-clock" style="color:var(--muted); font-size:16px;"></i>
                <div style="flex:1;">
                  <div style="font-size:13px; color:var(--chalk);">${e.minutes} min${e.note ? " · " + escapeHTML(e.note) : ""}</div>
                  <div style="font-size:11px; color:var(--muted);">${weekLabel(e.dateKey)}</div>
                </div>
                ${zi ? `<span style="font-size:10px; color:${zi.color}; border:1px solid var(--line); border-radius:12px; padding:2px 8px;">${zi.key}</span>` : ""}
                <button data-rmcardio="${e.id}" class="rm-x"><i class="ti ti-x"></i></button>
              </div>`;
            })
            .join("")
    }`;
}

function wireCardio(client, editable) {
  const backBtn = el("cardio-back");
  if (backBtn) backBtn.onclick = () => { ui.cardioOpen = false; render(); };

  const addBtn = el("cardio-add");
  const form = el("cardio-form");
  if (addBtn) addBtn.onclick = () => form.classList.toggle("hidden");

  const cancelBtn = el("cardio-cancel");
  if (cancelBtn) cancelBtn.onclick = () => form.classList.add("hidden");

  const saveBtn = el("cardio-save");
  if (saveBtn) {
    saveBtn.onclick = () => {
      const minutes = parseInt(el("cardio-minutes").value, 10);
      const zone = el("cardio-zone").value;
      const note = el("cardio-note").value.trim();
      const errorEl = el("cardio-error");
      errorEl.textContent = "";
      if (!minutes || minutes <= 0) {
        errorEl.textContent = "Informe quantos minutos.";
        return;
      }
      const entry = { id: uid(), dateKey: todayKey(), minutes, zone, note };
      const next = [...(client.cardio || []), entry];
      saveClient(client.id, { cardio: next });
      form.classList.add("hidden");
    };
  }

  document.querySelectorAll("[data-rmcardio]").forEach((btn) => {
    btn.onclick = () => {
      if (!confirm("Remover esse registro de cardio?")) return;
      const next = (client.cardio || []).filter((e) => e.id !== btn.dataset.rmcardio);
      saveClient(client.id, { cardio: next });
    };
  });
}

// ---------- feedbacks / observações ----------

const WHATSAPP_NUMBER = "5519993150750"; // 55 (Brasil) + 19 (DDD) + número, sem espaços/traços

function unreadDotHTML() {
  return '<span style="position:absolute;top:-4px;right:-4px;width:12px;height:12px;background:var(--red);border-radius:50%;border:2px solid var(--panel);box-shadow:0 0 6px var(--red);"></span>';
}

// Cada mensagem tem um único destinatário: quem não a escreveu. Marcar todas
// como lidas apagava o aviso do outro lado assim que quem escreveu reabria a
// conversa. É a mesma regra do 2.0, que grava nos mesmos campos.
function isFeedbackUnreadFor(f, who) {
  return !f.read && f.from !== who;
}

function hasUnreadFeedbackFor(client, who) {
  return (client.feedback || []).some((f) => isFeedbackUnreadFor(f, who));
}

function markFeedbackReadFor(client, who) {
  if (!hasUnreadFeedbackFor(client, who)) return;
  const updated = client.feedback.map((f) => (isFeedbackUnreadFor(f, who) ? { ...f, read: true } : f));
  saveClient(client.id, { feedback: updated });
}

function feedbackHTML(client, editable) {
  const entries = [...(client.feedback || [])].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const who = editable ? "treinador" : "aluno";

  return `
    <div class="day-head">
      <button class="back" id="feedback-back"><i class="ti ti-chevron-left"></i> ${editable ? "Aluno" : "Início"}</button>
      <div class="display day-title" style="font-size:18px;">Feedbacks / Observações</div>
    </div>

    <a href="https://wa.me/${WHATSAPP_NUMBER}" target="_blank" rel="noopener" class="cta" style="display:flex; align-items:center; justify-content:center; gap:8px; margin-bottom:16px; text-decoration:none;">
      <i class="ti ti-brand-whatsapp"></i> Falar direto no WhatsApp
    </a>

    <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:16px;">
      ${
        entries.length === 0
          ? `<p class="muted-note">Nenhuma mensagem ainda. Escreva o que quiser pro ${editable ? "aluno" : "seu personal"} aqui embaixo.</p>`
          : entries
              .map((m) => {
                const mine = m.from === who;
                return `
                <div style="align-self:${mine ? "flex-end" : "flex-start"}; max-width:85%; background:${mine ? "var(--redDim)" : "var(--panel)"}; border:1px solid ${mine ? "var(--red)" : "var(--line)"}; border-radius:12px; padding:8px 12px;">
                  <div style="font-size:10px; color:var(--muted); margin-bottom:2px; text-transform:uppercase; letter-spacing:.03em;">${m.from === "aluno" ? "Aluno" : "Personal"} · ${weekLabel(m.dateKey)}</div>
                  <div style="font-size:13px; color:var(--chalk); white-space:pre-wrap;">${escapeHTML(m.text)}</div>
                  ${editable ? `<button data-rmfeedback="${m.id}" class="rm-x" style="margin-top:4px;"><i class="ti ti-trash" style="font-size:12px;"></i></button>` : ""}
                </div>`;
              })
              .join("")
      }
    </div>

    <textarea id="feedback-text" rows="3" placeholder="Escreva à vontade…" style="width:100%; background:var(--panelAlt); border:1px solid var(--line); border-radius:8px; padding:10px; color:var(--chalk); resize:none; margin-bottom:8px;"></textarea>
    <button id="feedback-send" class="dashed-btn" style="width:100%; justify-content:center;"><i class="ti ti-send"></i> Enviar</button>
  `;
}

function wireFeedback(client, editable) {
  const backBtn = el("feedback-back");
  if (backBtn) backBtn.onclick = () => { ui.feedbackOpen = false; render(); };

  const who = editable ? "treinador" : "aluno";
  const sendBtn = el("feedback-send");
  if (sendBtn) {
    sendBtn.onclick = () => {
      const textEl = el("feedback-text");
      const text = textEl.value.trim();
      if (!text) return;
      const entry = { id: uid(), dateKey: todayKey(), from: who, text, read: false };
      const next = [...(client.feedback || []), entry];
      saveClient(client.id, { feedback: next });
      textEl.value = "";
    };
  }

  document.querySelectorAll("[data-rmfeedback]").forEach((btn) => {
    btn.onclick = () => {
      if (!confirm("Remover essa mensagem?")) return;
      const next = (client.feedback || []).filter((m) => m.id !== btn.dataset.rmfeedback);
      saveClient(client.id, { feedback: next });
    };
  });
}

// ---------- volume por grupo muscular (infográfico) ----------

function muscleVolumeHTML(client, editable) {
  const data = clientMuscleVolume(client);
  const maxTotal = data.length ? Math.max(...data.map(([, v]) => v.total)) : 1;

  return `
    <div class="day-head">
      <button class="back" id="muscle-back"><i class="ti ti-chevron-left"></i> ${editable ? "Aluno" : "Início"}</button>
      <div class="display day-title" style="font-size:18px;">Volume muscular</div>
    </div>
    <p class="muted-note" style="margin-bottom:18px;">Total de séries por grupo muscular, somando todos os treinos cadastrados. A parte colorida da barra mostra quanto já foi feito. Exercícios compostos contam ½ série a mais pro músculo sinergista (ex.: supino soma ½ série pro tríceps).</p>
    ${
      data.length === 0
        ? `<p class="muted-note">Nenhum exercício com grupo muscular classificado ainda. Os exercícios são classificados sozinhos pelo nome — se algum não aparecer aqui, digite o nome dele de novo ou escolha o grupo manualmente.</p>`
        : `<div style="display:flex; flex-direction:column; gap:16px;">
            ${data
              .map(([muscle, v]) => {
                const totalPct = Math.round((v.total / maxTotal) * 100);
                const donePct = Math.round((v.done / maxTotal) * 100);
                return `
              <div>
                <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:5px;">
                  <span style="font-size:14px; color:var(--chalk); font-weight:600;">${escapeHTML(muscle)}</span>
                  <span style="font-size:12px; color:var(--muted);">${fmtVol(v.done)}/${fmtVol(v.total)} séries</span>
                </div>
                <div style="background:var(--panelAlt); border:1px solid var(--line); border-radius:8px; height:16px; position:relative; overflow:hidden;">
                  <div style="position:absolute; top:0; left:0; height:100%; width:${totalPct}%; background:var(--line);"></div>
                  <div style="position:absolute; top:0; left:0; height:100%; width:${donePct}%; background:var(--red);"></div>
                </div>
              </div>`;
              })
              .join("")}
          </div>`
    }
  `;
}

function wireMuscleVolume(client, editable) {
  const backBtn = el("muscle-back");
  if (backBtn) backBtn.onclick = () => { ui.muscleOpen = false; render(); };
}

// ---------- visualização (só leitura) de uma semana já passada ----------

function pastWeekHTML(client, editable) {
  const days = pastWeekByDay(client, ui.pastWeekKey);
  return `
    <div class="day-head">
      <button class="back" id="pastweek-back"><i class="ti ti-chevron-left"></i> Calendário</button>
      <div class="display day-title" style="font-size:18px;">${weekRangeLabel(ui.pastWeekKey)}</div>
    </div>
    <p class="muted-note" style="margin-bottom:16px;"><i class="ti ti-lock"></i> Só leitura — mostra o que ficou registrado naquela semana.</p>
    ${
      days.length === 0
        ? `<p class="muted-note">Nenhum registro encontrado pra essa semana.</p>`
        : days
            .map(
              (d) => `
            <div style="margin-bottom:20px;">
              <div class="display" style="font-size:15px; margin-bottom:8px; color:var(--chalk);">${escapeHTML(d.title)}</div>
              ${d.exercises
                .map(
                  (ex) => `
                <div style="background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:10px 12px; margin-bottom:8px;">
                  <div style="font-size:13px; font-weight:600; color:var(--chalk); margin-bottom:6px;">${escapeHTML(ex.name)}</div>
                  ${ex.sets
                    .map(
                      (s, i) => `
                    <div style="display:flex; gap:10px; font-size:12px; color:var(--muted); padding:3px 0;">
                      <span style="width:20px;">${i + 1}ª</span>
                      <span style="color:var(--plate);">meta ${escapeHTML(s.repsGoal || "-")}</span>
                      <span style="color:var(--chalk);">feito ${escapeHTML(s.repsDone || "-")}</span>
                      <span style="color:var(--steel);">${escapeHTML(s.load || "-")}kg</span>
                    </div>`
                    )
                    .join("")}
                </div>`
                )
                .join("")}
            </div>`
            )
            .join("")
    }
  `;
}

function wirePastWeek(client, editable) {
  const backBtn = el("pastweek-back");
  if (backBtn) backBtn.onclick = () => { ui.pastWeekKey = null; ui.calendarOpen = true; render(); };
}

function planEditHTML(client, editable) {
  const plan = (client.weekPlans || []).find((p) => p.weekKey === ui.planWeekKey);
  if (!plan) {
    return `<p class="muted-note">Essa semana ainda não tem um plano.</p>
      <button class="back" id="plan-back"><i class="ti ti-chevron-left"></i> Calendário</button>`;
  }
  // reaproveita a mesma área de treinos, só que "olhando" pros dias do plano
  const proxyClient = { ...client, days: plan.days, __planId: plan.id };

  return `
    <div class="day-head">
      <button class="back" id="plan-back"><i class="ti ti-chevron-left"></i> Calendário</button>
      <div class="display day-title" style="font-size:16px;">Plano — ${weekRangeLabel(plan.weekKey)}</div>
    </div>
    ${
      editable
        ? `<div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; background: var(--panelAlt); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 14px;">
            <span id="plan-status">${planStatusHTML()}</span>
            <span style="font-size: 11px; color: var(--muted); flex-shrink: 0;">salva sozinho</span>
          </div>
          <div style="display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap;">
            <button class="dashed-btn" id="plan-activate"><i class="ti ti-check"></i> Ativar essa semana agora</button>
            <button class="dashed-btn" id="plan-delete"><i class="ti ti-trash"></i> Apagar plano</button>
          </div>`
        : ""
    }
    ${clientAreaHTMLInner(proxyClient, editable)}
  `;
}

function wirePlanEdit(client, editable) {
  const backBtn = el("plan-back");
  if (backBtn) {
    backBtn.onclick = async () => {
      // se ainda houver alteração na fila, grava antes de sair
      if (planSaveTimer) {
        clearTimeout(planSaveTimer);
        planSaveTimer = null;
        await flushPlanSave(client.id);
      }
      ui.planWeekKey = null;
      ui.planSaveState = "idle";
      clearPendingPlanEdit();
      ui.planSavedAt = null;
      ui.calendarOpen = true;
      render();
    };
  }

  const plan = (client.weekPlans || []).find((p) => p.weekKey === ui.planWeekKey);
  if (!plan) return;
  const proxyClient = { ...client, days: plan.days, __planId: plan.id };

  const activateBtn = el("plan-activate");
  if (activateBtn) {
    activateBtn.onclick = async () => {
      if (!confirm(`Ativar o plano de ${weekRangeLabel(plan.weekKey)} como semana atual agora? Isso substitui o treino atual do aluno.`)) return;
      cancelPendingPlanSave();
      const nextPlans = (client.weekPlans || []).filter((p) => p.id !== plan.id);
      const freshDays = withRefLoads(client, plan.days, plan.weekKey);
      await saveClient(client.id, { days: freshDays, activeWeekKey: weekKeyOf(todayKey()), weekPlans: nextPlans });
      ui.planWeekKey = null;
      ui.planSaveState = "idle";
      clearPendingPlanEdit();
      ui.planSavedAt = null;
      ui.calendarOpen = false;
    };
  }
  const deleteBtn = el("plan-delete");
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      if (!confirm("Apagar esse plano de semana futura?")) return;
      cancelPendingPlanSave();
      const nextPlans = (client.weekPlans || []).filter((p) => p.id !== plan.id);
      await saveClient(client.id, { weekPlans: nextPlans });
      ui.planWeekKey = null;
      ui.planSaveState = "idle";
      clearPendingPlanEdit();
      ui.planSavedAt = null;
      ui.calendarOpen = true;
    };
  }

  wireClientAreaInner(proxyClient, editable);
}

// ---------- crescimento automático dos quadrados meta/kg ----------

function growBox(input) {
  const box = input.closest(".box");
  if (!box) return;
  // quando o campo está vazio, o número de referência (placeholder) é o que
  // aparece — a caixa precisa caber ele também
  const len = (input.value || input.placeholder || "").length;
  box.style.width = Math.max(30, len * 11 + 22) + "px";
}

// redimensiona e comprime a foto no próprio navegador antes de salvar
// (sem precisar de nenhum servidor de armazenamento — fica leve o suficiente
// pra caber direto no banco de dados que já usamos)
function compressImageToDataUrl(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round((height * maxDim) / width); width = maxDim; }
        else if (height > maxDim) { width = Math.round((width * maxDim) / height); height = maxDim; }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function growTextarea(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}


// ---------- utilitários ----------

function escapeHTML(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function attr(str) { return escapeHTML(str).replace(/\n/g, "&#10;"); }

// ---------- banner "instalar app" ----------

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner("android");
});

function showInstallBanner(kind) {
  if (isStandalone()) return; // já instalado, não precisa avisar
  if (localStorage.getItem("install-banner-dismissed") === "1") return;

  const el = document.getElementById("install-banner");
  el.classList.remove("hidden");

  if (kind === "android") {
    el.innerHTML = `<span>Instale este app no seu celular pra acesso rápido, direto da tela inicial.</span>
      <button id="ib-install">Instalar</button>
      <button id="ib-dismiss"><i class="ti ti-x"></i></button>`;
    el.querySelector("#ib-install").onclick = async () => {
      el.classList.add("hidden");
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
      }
    };
  } else {
    el.innerHTML = `<span>Toque em <b>Compartilhar</b> (⬆️) e depois em <b>"Adicionar à Tela de Início"</b> pra instalar o app.</span>
      <button id="ib-dismiss"><i class="ti ti-x"></i></button>`;
  }

  el.querySelector("#ib-dismiss").onclick = () => {
    el.classList.add("hidden");
    localStorage.setItem("install-banner-dismissed", "1");
  };
}

window.addEventListener("load", () => {
  if (isIOS() && !isStandalone()) {
    setTimeout(() => showInstallBanner("ios"), 1500);
  }
});

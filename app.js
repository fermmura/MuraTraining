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

let ui = { view: "loading", selectedId: null, activeDayId: null, progOpen: false, progMode: "table", progKey: null, studentEnteredTreinos: false, calendarOpen: false, planWeekKey: null, themeOpen: false, cardioOpen: false, feedbackOpen: false, muscleOpen: false };
let draggedDayId = null;
let collapsedEx = {}; // exercícios minimizados; por padrão, todo exercício começa minimizado
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
    unsubscribe = db.collection("clients").onSnapshot((snap) => {
      clients = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      clients.forEach((c) => maybePromoteWeek(c));
      render();
    });
  } else {
    ui = { view: "student", activeDayId: null };
    unsubscribe = db
      .collection("clients")
      .where("email", "==", user.email.toLowerCase())
      .onSnapshot((snap) => {
        myClient = snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
        if (myClient) maybePromoteWeek(myClient);
        render();
      });
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

// clona os dias de treino de outro aluno, gerando ids novos pra tudo
// (dias, exercícios e séries), sem carregar nenhum histórico/progresso junto
function cloneDaysWithNewIds(days, resetDone = true) {
  return (days || []).map((d) => ({
    ...d,
    id: uid(),
    exercises: (d.exercises || []).map((ex) => ({
      ...ex,
      id: uid(),
      sets: (ex.sets || []).map((s) => ({ ...s, id: uid(), repsDone: resetDone ? "" : s.repsDone })),
    })),
  }));
}

// verifica se a semana virou de verdade (no calendário) e, se tiver um plano
// pronto pra essa semana, promove ele automaticamente pra virar o treino atual —
// sem precisar de nenhum clique do treinador
const promotedThisSession = new Set();
async function maybePromoteWeek(client) {
  const currentKey = weekKeyOf(todayKey());
  const activeKey = client.activeWeekKey || currentKey;
  if (currentKey === activeKey) return;
  if (currentKey < activeKey) return; // segurança: nunca "volta" a semana
  const sessionFlag = client.id + ":" + currentKey;
  if (promotedThisSession.has(sessionFlag)) return;
  promotedThisSession.add(sessionFlag);

  const plans = client.weekPlans || [];
  const plan = plans.find((p) => p.weekKey === currentKey);
  try {
    if (plan) {
      const nextPlans = plans.filter((p) => p.id !== plan.id);
      await saveClient(client.id, { days: plan.days, activeWeekKey: currentKey, weekPlans: nextPlans });
    } else {
      await saveClient(client.id, { activeWeekKey: currentKey });
    }
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

function saveClient(id, patch) {
  db.collection("clients").doc(id).update(patch).catch((e) => alert("Erro ao salvar: " + e.message));
}

function emptySet() { return { id: uid(), repsGoal: "10", repsDone: "", load: "", intensity: 0, rir: "", rirEnabled: false }; }
function emptyExercise() { return { id: uid(), name: "", notes: "", sets: [emptySet()] }; }

function emptyDay(title) { return { id: uid(), title, exercises: [] }; }

function updateDays(client, nextDays) {
  if (client.__planId) {
    const nextPlans = (client.weekPlans || []).map((p) => (p.id === client.__planId ? { ...p, days: nextDays } : p));
    saveClient(client.id, { weekPlans: nextPlans });
    return;
  }
  saveClient(client.id, { days: nextDays });
}

// ---------- render ----------

function render() {
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
      if (feedbackBtn) feedbackBtn.onclick = () => { ui.feedbackOpen = true; render(); };
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

        <button id="enter-feedback" class="home-btn home-glow-muted">
          <i class="ti ti-message-circle"></i>
          <span class="display">Feedbacks / Observações</span>
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

function dayVolume(day) {
  let total = 0, done = 0;
  for (const ex of day.exercises || []) {
    for (const s of ex.sets || []) {
      total++;
      if (s.repsDone) done++;
    }
  }
  return { done, total };
}

const MUSCLE_GROUPS = [
  "Peito", "Costas", "Ombro", "Trapézio", "Bíceps", "Tríceps", "Antebraço",
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

function muscleVolume(day) {
  const byMuscle = {};
  for (const ex of day.exercises || []) {
    const muscle = ex.muscle || "";
    if (!muscle) continue;
    if (!byMuscle[muscle]) byMuscle[muscle] = { done: 0, total: 0 };
    for (const s of ex.sets || []) {
      byMuscle[muscle].total++;
      if (s.repsDone) byMuscle[muscle].done++;
    }
  }
  return Object.entries(byMuscle).sort((a, b) => b[1].total - a[1].total);
}

function clientMuscleVolume(client) {
  const byMuscle = {};
  for (const day of client.days || []) {
    for (const ex of day.exercises || []) {
      const muscle = ex.muscle || "";
      if (!muscle) continue;
      if (!byMuscle[muscle]) byMuscle[muscle] = { done: 0, total: 0 };
      for (const s of ex.sets || []) {
        byMuscle[muscle].total++;
        if (s.repsDone) byMuscle[muscle].done++;
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
  return clientAreaHTMLInner(client, editable);
}

function clientAreaHTMLInner(client, editable) {
  const day = (client.days || []).find((d) => d.id === ui.activeDayId);

  if (!day) {
    return `
      ${
        !client.__planId
          ? `<div class="toolbar-nav">
              <button class="dashed-btn" id="open-calendar"><i class="ti ti-calendar-stats"></i> Calendário</button>
              <button class="dashed-btn" id="open-cardio"><i class="ti ti-heart-rate-monitor"></i> Cardio</button>
              <button class="dashed-btn" id="open-progression"><i class="ti ti-chart-line"></i> Progressão</button>
              <button class="dashed-btn" id="open-muscle"><i class="ti ti-chart-donut-3"></i> Volume muscular</button>
              <button class="dashed-btn" id="open-feedback"><i class="ti ti-message-circle"></i> Feedbacks</button>
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
            const vol = dayVolume(d);
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
        const vol = dayVolume(day);
        if (vol.total === 0) return "";
        const byMuscle = muscleVolume(day);
        const totalLine = `<div class="muted-note" style="margin:-10px 0 8px; color:${vol.done === vol.total ? "#639922" : "var(--muted)"};">${vol.done}/${vol.total} séries feitas</div>`;
        const muscleLine =
          byMuscle.length > 0
            ? `<div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px;">
                ${byMuscle
                  .map(
                    ([m, v]) =>
                      `<span class="muscle-vol-pill">${escapeHTML(m)}: <b>${v.done}/${v.total}</b></span>`
                  )
                  .join("")}
              </div>`
            : "";
        return totalLine + muscleLine;
      })()
    }
    <div id="exercises-wrap">
      ${(day.exercises || []).map((ex, i, arr) => exerciseHTML(ex, editable, i, arr.length)).join("")}
    </div>
    ${editable ? `<button class="dashed-btn" id="add-exercise">+ adicionar exercício</button>` : ""}
  `;
}

function exerciseHTML(ex, editable, index, total) {
  const collapsed = isCollapsed(ex.id);
  return `
    <div class="ex-card" data-exid="${ex.id}">
      <div class="ex-top">
        ${
          editable
            ? `<input class="ex-name" data-field="name" placeholder="Exercício" value="${attr(ex.name)}" />`
            : `<div class="ex-name">${escapeHTML(ex.name || "Exercício")}</div>`
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
        editable
          ? `<select class="muscle-select" data-field="muscle">
              <option value="">Grupo muscular…</option>
              ${MUSCLE_GROUPS.map((m) => `<option value="${m}" ${ex.muscle === m ? "selected" : ""}>${m}</option>`).join("")}
            </select>`
          : ex.muscle
          ? `<span class="muscle-tag">${escapeHTML(ex.muscle)}</span>`
          : ""
      }
      <div class="ex-body ${collapsed ? "hidden" : ""}">
        <div class="notes-box">
          <label>ANOTAÇÕES</label>
          <textarea rows="3" data-field="notes" data-autogrow="1" placeholder="ex.: preparatória com 2 séries leves de 15 reps; trabalho com cadência 2-0-2, descanso 90s"
            ${editable ? "" : "readonly"}>${escapeHTML(ex.notes || "")}</textarea>
          ${
            ex.photoUrl
              ? `<div style="margin-top:8px;position:relative;">
                  <a href="${escapeHTML(ex.photoUrl)}" target="_blank" rel="noopener">
                    <img src="${escapeHTML(ex.photoUrl)}" alt="Foto do exercício ${escapeHTML(ex.name || "")}" style="width:100%;max-height:220px;object-fit:cover;border-radius:8px;display:block;" />
                  </a>
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
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--muted);">SÉRIES DE TRABALHO</label>
          ${(ex.sets || []).map((s, i) => setRowHTML(ex.id, s, i, editable)).join("")}
          ${editable ? `<button class="dashed-btn" data-addset="${ex.id}" style="margin-top:6px;">+ série</button>` : ""}
        </div>
      </div>
    </div>`;
}

function setRowHTML(exId, s, i, editable) {
  const goal = s.repsGoal ?? s.reps ?? ""; // compatível com fichas antigas (campo único "reps")
  const rirOn = !!s.rirEnabled;
  return `
    <div class="set-row" data-setid="${s.id}" data-exid="${exId}">
      <span class="set-idx">${i + 1}ª</span>
      <span class="stack" style="color:var(--plate);">
        <span class="box meta grow"><input data-field="repsGoal" data-grow="1" value="${attr(goal)}" placeholder="meta" ${editable ? "" : "readonly"} /></span>
        <span class="unit">meta</span>
      </span>
      <span class="stack" style="color:var(--chalk);position:relative;">
        ${
          editable
            ? `<span class="box"><input data-field="repsDone" data-grow="1" value="${attr(s.repsDone)}" placeholder="0" /></span>`
            : `<button type="button" class="box feito-open" data-feitoopen="1">${escapeHTML(s.repsDone || "–")}</button>`
        }
        <span class="unit">feito</span>
      </span>
      <span class="stack" style="color:var(--steel);">
        <span class="box kg grow"><input data-field="load" data-grow="1" value="${attr(s.load)}" /></span>
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
      ${editable ? `<button class="rm-x" data-rmset="1"><i class="ti ti-x"></i></button>` : ""}
    </div>`;
}

// ---------- eventos da área de treinos (funciona pra treinador e aluno) ----------

function wireClientArea(client, editable) {
  if (!client) return;

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

  wireClientAreaInner(client, editable);
}

function wireClientAreaInner(client, editable) {
  if (editable && !client.__planId) {
    wireImportModal(client);
    wireDuplicateModal(client);
  }

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
  if (backBtn) backBtn.onclick = () => { ui.activeDayId = null; render(); };

  const dayTitleInput = el("day-title-input");
  if (dayTitleInput) dayTitleInput.onchange = () => {
    const days = (client.days || []).map((d) => (d.id === ui.activeDayId ? { ...d, title: dayTitleInput.value } : d));
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
        const days = (client.days || []).map((d) => {
          if (d.id !== ui.activeDayId) return d;
          return {
            ...d,
            exercises: (d.exercises || []).map((ex) => {
              if (ex.id !== exId) return ex;
              const patch = { [field]: input.value };
              // se o nome mudou e o músculo ainda não foi escolhido, tenta adivinhar sozinho
              if (field === "name" && !ex.muscle) {
                const guessed = guessMuscle(input.value);
                if (guessed) patch.muscle = guessed;
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
          const days = (client.days || []).map((d) => {
            if (d.id !== ui.activeDayId) return d;
            return { ...d, exercises: (d.exercises || []).map((ex) => (ex.id === exId ? { ...ex, photoUrl: dataUrl } : ex)) };
          });
          updateDays(client, days);
        } catch (e) {
          if (statusEl) statusEl.textContent = "erro ao processar a foto";
        }
      };
    }

    const rmPhotoBtn = card.querySelector(`[data-rmphoto="${exId}"]`);
    if (rmPhotoBtn) {
      rmPhotoBtn.onclick = () => {
        if (!confirm("Remover essa foto?")) return;
        const days = (client.days || []).map((d) => {
          if (d.id !== ui.activeDayId) return d;
          return { ...d, exercises: (d.exercises || []).map((ex) => (ex.id === exId ? { ...ex, photoUrl: "" } : ex)) };
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

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function weekKeyOf(dateKey) {
  const d = new Date(dateKey + "T00:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // volta pra segunda-feira daquela semana
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  return monday.toISOString().slice(0, 10);
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
  if (client.__planId) {
    // plano futuro: só atualiza o próprio plano, sem registrar histórico
    // (nada foi "feito" de verdade ainda)
    const days = (client.days || []).map((d) => {
      if (d.id !== dayId) return d;
      return {
        ...d,
        exercises: (d.exercises || []).map((ex) => {
          if (ex.id !== exId) return ex;
          return { ...ex, sets: (ex.sets || []).map((s) => (s.id === setId ? { ...s, [field]: value } : s)) };
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
    currentExercise = { id: uid(), name: exName, muscle: guessMuscle(exName), notes: "", sets: [], _notesArr: [] };
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
  const nums = Array.from({ length: 15 }, (_, i) => i + 1);

  el.innerHTML = `
    <div class="fp-backdrop" id="fp-backdrop"></div>
    <div class="fp-card">
      <div class="fp-title">Quantas repetições você fez?</div>
      <div class="fp-scroll" id="fp-scroll">
        <div class="fp-pad"></div>
        ${nums
          .map((n) => `<div class="fp-item ${String(n) === String(currentVal) ? "selected" : ""}" data-num="${n}">${n}</div>`)
          .join("")}
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

  document.getElementById("fp-backdrop").onclick = closeFeitoPicker;
  document.getElementById("fp-cancel").onclick = closeFeitoPicker;
}

// ---------- tela de progressão (tabela + gráfico, só treinador) ----------

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

function progressionHTML(client) {
  const rows = buildHistoryIndex(client);
  const weeks = allWeekKeys(client).slice(-8);
  return `
    <div class="day-head">
      <button class="back" id="prog-back"><i class="ti ti-chevron-left"></i> Aluno</button>
      <div class="display day-title">Progressão</div>
    </div>
    <div style="display:flex; gap:8px; margin-bottom:14px;">
      <button class="dashed-btn" id="prog-tab-table" style="${ui.progMode === "table" ? "border-style:solid;color:var(--chalk);" : ""}">Tabela</button>
      <button class="dashed-btn" id="prog-tab-chart" style="${ui.progMode === "chart" ? "border-style:solid;color:var(--chalk);" : ""}">Gráfico</button>
    </div>
    ${
      rows.length === 0
        ? `<p class="muted-note">Ainda não há histórico. Assim que reps ou kg forem alterados pelo aluno (ou por você), a progressão aparece aqui, semana a semana.</p>`
        : ui.progMode === "table"
        ? progTableHTML(rows, weeks)
        : progChartHTML(rows)
    }`;
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

function progChartHTML(rows) {
  const selected = ui.progKey && rows.find((r) => r.setId === ui.progKey) ? ui.progKey : rows[0] && rows[0].setId;
  ui.progKey = selected;
  return `
    <select id="prog-select" style="width:100%; margin-bottom:14px; padding:9px; background:var(--panelAlt); border:1px solid var(--line); border-radius:8px; color:var(--chalk); font-size:14px;">
      ${rows
        .map((r) => `<option value="${r.setId}" ${r.setId === selected ? "selected" : ""}>${escapeHTML(r.label)}${r.dayTitle ? " — " + escapeHTML(r.dayTitle) : ""}</option>`)
        .join("")}
    </select>
    <div style="position:relative; width:100%; height:240px;">
      <canvas id="prog-canvas"></canvas>
    </div>`;
}

let progChartInstance = null;

function renderProgChart(client) {
  const canvas = document.getElementById("prog-canvas");
  if (!canvas || !window.Chart) return;
  const entries = (client.history || []).filter((h) => h.setId === ui.progKey);
  const byWeek = {};
  for (const e of entries) {
    if (!byWeek[e.weekKey] || e.dateKey > byWeek[e.weekKey].dateKey) byWeek[e.weekKey] = e;
  }
  const weeks = Object.keys(byWeek).sort();
  const labels = weeks.map(weekLabel);
  const useLoad = weeks.some((w) => byWeek[w].load);
  const data = weeks.map((w) => {
    const v = useLoad ? byWeek[w].load : byWeek[w].repsDone;
    const n = parseFloat(String(v).replace(",", "."));
    return isNaN(n) ? null : n;
  });

  if (progChartInstance) progChartInstance.destroy();
  progChartInstance = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data,
          borderColor: "#FF4433",
          backgroundColor: "rgba(255,68,51,0.1)",
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointBackgroundColor: "#FF4433",
          pointBorderColor: "#17161A",
          pointBorderWidth: 2,
          borderWidth: 2,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { ticks: { color: "#9A94A6", font: { size: 11 } }, grid: { color: "#2A2830" } },
        x: { ticks: { color: "#9A94A6", font: { size: 11 } }, grid: { display: false } },
      },
    },
  });
}

function wireProgression(client) {
  const backBtn = document.getElementById("prog-back");
  if (backBtn) backBtn.onclick = () => { ui.progOpen = false; render(); };

  const tabTable = document.getElementById("prog-tab-table");
  const tabChart = document.getElementById("prog-tab-chart");
  if (tabTable) tabTable.onclick = () => { ui.progMode = "table"; render(); };
  if (tabChart) tabChart.onclick = () => { ui.progMode = "chart"; render(); };

  if (ui.progMode === "chart") {
    const select = document.getElementById("prog-select");
    if (select) {
      select.onchange = () => { ui.progKey = select.value; render(); };
      renderProgChart(client);
    }
  }
}

// ---------- calendário de semanas ----------

function addWeeks(weekKey, n) {
  const d = new Date(weekKey + "T00:00:00");
  d.setDate(d.getDate() + n * 7);
  return d.toISOString().slice(0, 10);
}

function weekRangeLabel(weekKey) {
  const start = new Date(weekKey + "T00:00:00");
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return `${weekLabel(weekKey)} – ${weekLabel(end.toISOString().slice(0, 10))}`;
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

function calendarHTML(client, editable) {
  const activeKey = client.activeWeekKey || weekKeyOf(todayKey());
  const plans = client.weekPlans || [];
  const offsets = [-2, -1, 0, 1, 2, 3];

  return `
    <div class="day-head">
      <button class="back" id="cal-back"><i class="ti ti-chevron-left"></i> Aluno</button>
      <div class="display day-title">Calendário</div>
    </div>
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

  document.querySelectorAll("[data-calweek]").forEach((row) => {
    row.onclick = async () => {
      const wk = row.dataset.calweek;
      const off = parseInt(row.dataset.caloff, 10);
      const activeKey = client.activeWeekKey || weekKeyOf(todayKey());

      if (off < 0) return; // semanas passadas: só o resumo já mostrado no card, sem tela própria por ora
      if (off === 0) {
        ui.calendarOpen = false; // semana atual: volta pra grade normal de treinos
        render();
        return;
      }

      // semana futura
      const plans = client.weekPlans || [];
      let plan = plans.find((p) => p.weekKey === wk);
      if (!plan && editable) {
        plan = { id: uid(), weekKey: wk, days: cloneDaysWithNewIds(client.days || [], false) };
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
      const entry = { id: uid(), dateKey: todayKey(), from: who, text };
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
    <p class="muted-note" style="margin-bottom:18px;">Total de séries por grupo muscular, somando todos os treinos cadastrados. A parte colorida da barra mostra quanto já foi feito.</p>
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
                  <span style="font-size:12px; color:var(--muted);">${v.done}/${v.total} séries</span>
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
        ? `<div style="display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap;">
            <button class="dashed-btn" id="plan-activate"><i class="ti ti-check"></i> Ativar essa semana agora</button>
            <button class="dashed-btn" id="plan-refresh"><i class="ti ti-refresh"></i> Atualizar "feito" com o treino atual</button>
            <button class="dashed-btn" id="plan-delete"><i class="ti ti-trash"></i> Apagar plano</button>
          </div>`
        : ""
    }
    ${clientAreaHTMLInner(proxyClient, editable)}
  `;
}

function wirePlanEdit(client, editable) {
  const backBtn = el("plan-back");
  if (backBtn) backBtn.onclick = () => { ui.planWeekKey = null; ui.calendarOpen = true; render(); };

  const plan = (client.weekPlans || []).find((p) => p.weekKey === ui.planWeekKey);
  if (!plan) return;
  const proxyClient = { ...client, days: plan.days, __planId: plan.id };

  const activateBtn = el("plan-activate");
  if (activateBtn) {
    activateBtn.onclick = async () => {
      if (!confirm(`Ativar o plano de ${weekRangeLabel(plan.weekKey)} como semana atual agora? Isso substitui o treino atual do aluno.`)) return;
      const nextPlans = (client.weekPlans || []).filter((p) => p.id !== plan.id);
      await saveClient(client.id, { days: plan.days, activeWeekKey: plan.weekKey, weekPlans: nextPlans });
      ui.planWeekKey = null;
      ui.calendarOpen = false;
    };
  }
  const refreshBtn = el("plan-refresh");
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      // busca o "feito" pela posição (mesmo dia, mesmo exercício, mesma série)
      // no treino ATUAL do aluno, e traz pra dentro do plano
      const currentDays = client.days || [];
      const updatedDays = plan.days.map((d, di) => {
        const curDay = currentDays[di];
        if (!curDay) return d;
        return {
          ...d,
          exercises: (d.exercises || []).map((ex, ei) => {
            const curEx = curDay.exercises && curDay.exercises[ei];
            if (!curEx) return ex;
            return {
              ...ex,
              sets: (ex.sets || []).map((s, si) => {
                const curSet = curEx.sets && curEx.sets[si];
                return curSet ? { ...s, repsDone: curSet.repsDone } : s;
              }),
            };
          }),
        };
      });
      const nextPlans = (client.weekPlans || []).map((p) => (p.id === plan.id ? { ...p, days: updatedDays } : p));
      await saveClient(client.id, { weekPlans: nextPlans });
      refreshBtn.textContent = "Atualizado!";
      setTimeout(() => { refreshBtn.innerHTML = `<i class="ti ti-refresh"></i> Atualizar "feito" com o treino atual`; }, 1500);
    };
  }
  const deleteBtn = el("plan-delete");
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      if (!confirm("Apagar esse plano de semana futura?")) return;
      const nextPlans = (client.weekPlans || []).filter((p) => p.id !== plan.id);
      await saveClient(client.id, { weekPlans: nextPlans });
      ui.planWeekKey = null;
      ui.calendarOpen = true;
    };
  }

  wireClientAreaInner(proxyClient, editable);
}

// ---------- crescimento automático dos quadrados meta/kg ----------

function growBox(input) {
  const box = input.closest(".box");
  if (!box) return;
  const len = (input.value || "").length;
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
